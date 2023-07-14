import { EditorView } from '@codemirror/view';
import CSL from 'citeproc';
import ReferenceList from 'src/main';
import { PartialCSLEntry } from './types';
import Fuse from 'fuse.js';
import { bibToCSL, getCSLLocale, getCSLStyle, getZBib } from './helpers';
import { PromiseCapability } from 'src/helpers';
import {
  RenderedCitation,
  getCitationSegments,
  getCitations,
} from 'src/parser/parser';
import LRUCache from 'lru-cache';
import { MarkdownView, TFile } from 'obsidian';
import { cite } from 'src/parser/citeproc';
import { setCiteKeyCache } from 'src/editorExtension';
import equal from 'fast-deep-equal';

const fuseSettings = {
  includeMatches: true,
  threshold: 0.35,
  minMatchCharLength: 2,
  keys: [
    { name: 'id', weight: 0.7 },
    { name: 'title', weight: 0.3 },
  ],
};

interface ScopedSettings {
  style?: string;
  lang?: string;
  bibliography?: string;
}

export interface FileCache {
  keys: Set<string>;
  resolvedKeys: Set<string>;
  unresolvedKeys: Set<string>;
  bib: HTMLElement;
  citations: RenderedCitation[];
  citeBibMap: Map<string, string>;

  settings: ScopedSettings | null;

  source: {
    bibCache?: Map<string, PartialCSLEntry>;
    fuse?: Fuse<PartialCSLEntry>;
    engine?: any;
  };
}

function getScopedSettings(file: TFile): ScopedSettings {
  const metadata = app.metadataCache.getFileCache(file);
  const output: ScopedSettings = {};

  if (!metadata?.frontmatter) {
    return null;
  }

  const { frontmatter } = metadata;

  output.bibliography = frontmatter.bibliography?.trim() || undefined;
  output.style =
    frontmatter.csl?.trim() ||
    frontmatter['citation-style']?.trim() ||
    undefined;
  output.lang =
    frontmatter.lang?.trim() ||
    frontmatter['citation-language']?.trim() ||
    undefined;

  if (Object.values(output).every((v) => !v)) {
    return null;
  }

  return output;
}

function extractRawLocales(style: string, localeName?: string) {
  const locales = ['en-US'];
  if (localeName) {
    locales.push(localeName);
  }
  if (style) {
    const matches = style.match(/locale="[^"]+"/g);
    if (matches) {
      for (const match of matches) {
        const vals = match.slice(0, -1).slice(8).split(/\s+/);
        for (const val of vals) {
          locales.push(val);
        }
      }
    }
  }
  return normalizeLocales(locales);
}

function normalizeLocales(locales: string[]) {
  const obj: Record<string, boolean> = {};
  for (let locale of locales) {
    locale = locale.split('-').slice(0, 2).join('-');
    if (CSL.LANGS[locale]) {
      obj[locale] = true;
    } else {
      locale = locale.split('-')[0];
      if (CSL.LANG_BASES[locale]) {
        locale = CSL.LANG_BASES[locale].split('_').join('-');
        obj[locale] = true;
      }
    }
  }
  return Object.keys(obj);
}

export class BibManager {
  plugin: ReferenceList;
  fileCache: LRUCache<TFile, FileCache>;
  initPromise: PromiseCapability<void>;

  langCache: Map<string, string> = new Map();
  styleCache: Map<string, string> = new Map();

  bibCache: Map<string, PartialCSLEntry> = new Map();
  fuse: Fuse<PartialCSLEntry>;
  engine: any;

  constructor(plugin: ReferenceList) {
    this.plugin = plugin;
    this.initPromise = new PromiseCapability();
    this.fileCache = new LRUCache({ max: 10 });
  }

  destroy() {
    this.fileCache.clear();
    this.langCache.clear();
    this.styleCache.clear();
    this.bibCache.clear();
    this.fuse = null;
    this.engine = null;
    this.plugin = null;
  }

  async reinit(clearCache: boolean) {
    this.initPromise = new PromiseCapability();
    this.fileCache.clear();
    if (clearCache) this.bibCache.clear();

    if (this.plugin.settings.pullFromZotero) {
      await this.loadGlobalZBib(true);
    } else {
      await this.loadGlobalBibFile(true);
    }

    this.initPromise.resolve();
  }

  setFuse(data: PartialCSLEntry[] = []) {
    if (!this.fuse) {
      this.fuse = new Fuse(data, fuseSettings);
    } else {
      this.fuse.setCollection(data);
    }
  }

  async loadScopedEngine(settings: ScopedSettings) {
    if (!settings) return this;

    const pluginSettings = this.plugin.settings;
    let style =
      pluginSettings.cslStyleURL ??
      'https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl';
    let lang = pluginSettings.cslLang ?? 'en-US';
    let bibCache = this.bibCache;
    let fuse = this.fuse;
    let langs = [settings.lang];

    if (settings.style) {
      try {
        const isURL = /^http/.test(settings.style);
        const styleObj = isURL
          ? { id: settings.style }
          : { id: settings.style, explicitPath: settings.style };
        const styles = await this.loadStyles([styleObj]);
        for (const styleStr of styles) {
          langs = extractRawLocales(styleStr, settings.lang);
        }
        style = settings.style;
      } catch (e) {
        console.error(e);
        return this;
      }
    }

    if (settings.lang) {
      try {
        await this.loadLangs(langs);
        lang = settings.lang;
      } catch (e) {
        console.error(e);
        return this;
      }
    }

    if (settings.bibliography) {
      try {
        const bib = await bibToCSL(
          settings.bibliography,
          this.plugin.settings.pathToPandoc
        );
        bibCache = new Map();

        for (const entry of bib) {
          bibCache.set(entry.id, entry);
        }

        fuse = new Fuse(bib, fuseSettings);
      } catch (e) {
        console.error(e);
        return this;
      }
    }

    const engine = this.buildEngine(
      lang,
      this.langCache,
      style,
      this.styleCache,
      bibCache
    );

    return {
      bibCache,
      fuse,
      engine,
    };
  }

  async loadGlobalBibFile(fromCache?: boolean) {
    const { settings } = this.plugin;

    if (!settings.pathToBibliography) return;
    if (!fromCache || this.bibCache.size === 0) {
      const bib = await bibToCSL(
        settings.pathToBibliography,
        settings.pathToPandoc
      );

      this.bibCache = new Map();

      for (const entry of bib) {
        this.bibCache.set(entry.id, entry);
      }

      this.setFuse(bib);
    }

    const style =
      settings.cslStyleURL ??
      'https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl';
    const lang = settings.cslLang ?? 'en-US';

    this.getLangAndStyle(lang, {
      id: settings.cslStylePath || style,
      explicitPath: settings.cslStylePath,
    });
    if (!this.styleCache.has(style)) return;

    this.engine = this.buildEngine(
      lang,
      this.langCache,
      style,
      this.styleCache,
      this.bibCache
    );
  }

  async loadGlobalZBib(fromCache?: boolean) {
    const { settings, cacheDir } = this.plugin;
    if (!settings.zoteroGroups?.length) return;

    const bib: PartialCSLEntry[] = [];
    if (!fromCache || this.bibCache.size === 0) {
      for (const group of settings.zoteroGroups) {
        try {
          const list = await getZBib(settings.zoteroPort, cacheDir, group.id);
          if (list?.length) {
            bib.push(...list);
          } else {
            return;
          }
        } catch (e) {
          console.error('Error fetching bibliography from Zotero', e);
          return;
        }
      }

      this.bibCache = new Map();
      for (const entry of bib) {
        this.bibCache.set(entry.id, entry);
      }

      this.setFuse(bib);
    }

    const style =
      settings.cslStyleURL ??
      'https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl';
    const lang = settings.cslLang ?? 'en-US';

    await this.getLangAndStyle(lang, {
      id: settings.cslStylePath || style,
      explicitPath: settings.cslStylePath,
    });
    if (!this.styleCache.has(style)) return;

    this.engine = this.buildEngine(
      lang,
      this.langCache,
      style,
      this.styleCache,
      this.bibCache
    );
  }

  buildEngine(
    lang: string,
    langCache: Map<string, string>,
    style: string,
    styleCache: Map<string, string>,
    bibCache: Map<string, PartialCSLEntry>
  ) {
    const engine = new CSL.Engine(
      {
        retrieveLocale: (id: string) => {
          return langCache.get(id);
        },
        retrieveItem: (id: string) => {
          return bibCache.get(id);
        },
      },
      styleCache.get(style),
      lang
    );
    engine.opt.development_extensions.wrap_url_and_doi = true;
    return engine;
  }

  async getLangAndStyle(
    lang: string,
    style: { id: string; explicitPath?: string }
  ) {
    let styles: string[] = [];
    if (!this.styleCache.has(style.id)) {
      try {
        styles = await this.loadStyles([style]);
      } catch (e) {
        console.error('Error loading style', style, e);
        this.initPromise.resolve();
        return;
      }
    }

    let locales = [lang];
    for (const styleStr of styles) {
      locales = extractRawLocales(styleStr, lang);
    }

    try {
      await this.loadLangs(locales);
    } catch (e) {
      console.error('Error loading lang', lang, e);
      this.initPromise.resolve();
      return;
    }
  }

  async loadLangs(langs: string[]) {
    for (const lang of langs) {
      if (!lang) continue;
      if (!this.langCache.has(lang)) {
        await getCSLLocale(this.langCache, this.plugin.cacheDir, lang);
      }
    }
  }

  async loadStyles(styles: { id?: string; explicitPath?: string }[]) {
    const res: string[] = [];
    for (const style of styles) {
      if (!style.id && !style.explicitPath) continue;
      if (!this.styleCache.has(style.explicitPath ?? style.id)) {
        res.push(
          await getCSLStyle(
            this.styleCache,
            this.plugin.cacheDir,
            style.id,
            style.explicitPath
          )
        );
      }
    }
    return res;
  }

  getNoteForNoteIndex(file: TFile, index: string) {
    if (!this.fileCache.has(file)) {
      return null;
    }

    const cache = this.fileCache.get(file);
    const noteIndex = parseInt(index);

    const cite = cache.citations.find((c) => c.noteIndex === noteIndex);

    if (!cite.note) {
      return null;
    }

    const doc = new DOMParser().parseFromString(cite.note, 'text/html');
    return Array.from(doc.body.childNodes);
  }

  getBibForCiteKey(file: TFile, key: string) {
    if (!this.fileCache.has(file)) {
      return null;
    }

    const cache = this.fileCache.get(file);
    if (!cache.keys.has(key)) {
      return null;
    }

    const html = cache.citeBibMap.get(key);
    if (!html) {
      return null;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.firstChild;
  }

  async getReferenceList(file: TFile, content: string) {
    await this.plugin.initPromise.promise;
    await this.initPromise.promise;

    const segs = getCitationSegments(content);
    const processed = segs.map((s) => getCitations(s));

    if (!processed.length) return null;

    const citeKeys = new Set<string>();
    const unresolvedKeys = new Set<string>();
    const resolvedKeys = new Set<string>();
    const cachedDoc = this.fileCache.has(file)
      ? this.fileCache.get(file)
      : null;
    const citeBibMap = new Map<string, string>();
    const settings = getScopedSettings(file);

    processed.forEach((p) =>
      p.citations.forEach((c) => {
        if (c.id && !citeKeys.has(c.id)) {
          citeKeys.add(c.id);
        }
      })
    );

    const areSettingsEqual =
      settings?.bibliography === cachedDoc?.settings?.bibliography &&
      settings?.style === cachedDoc?.settings?.style &&
      settings?.lang === cachedDoc?.settings?.lang;

    const source =
      cachedDoc?.source && areSettingsEqual
        ? cachedDoc.source
        : await this.loadScopedEngine(settings);

    const setNull = (): null => {
      const result: FileCache = {
        keys: citeKeys,
        resolvedKeys,
        unresolvedKeys,
        bib: null,
        citations: [],
        citeBibMap,
        settings: null,
        source,
      };

      this.fileCache.set(file, result);
      this.dispatchResult(file, result);

      return null;
    };

    if (!source?.engine) {
      return setNull();
    }

    citeKeys.forEach((k) => {
      if (source.bibCache.has(k)) {
        resolvedKeys.add(k);
      } else {
        unresolvedKeys.add(k);
      }
    });

    const filtered = processed.filter((s) =>
      s.citations.every((c) => {
        const resolved = source.bibCache.has(c.id);
        if (resolved) {
          resolvedKeys.add(c.id);
        } else {
          unresolvedKeys.add(c.id);
        }
        return resolved;
      })
    );

    // Do we need this?
    // source.engine.updateItems(Array.from(resolvedKeys));

    const citations = cite(source.engine, filtered);

    if (
      cachedDoc &&
      equal(cachedDoc.citations, citations) &&
      areSettingsEqual
    ) {
      return cachedDoc.bib;
    }

    const bib = source.engine.makeBibliography();

    if (!bib?.length) {
      return setNull();
    }

    const metadata = bib[0];
    const entries = bib[1];
    const htmlStr = [metadata.bibstart];

    metadata.entry_ids?.forEach((e: string, i: number) => {
      citeBibMap.set(e[0], entries[i]);
    });

    for (const entry of entries) htmlStr.push(entry);

    htmlStr.push(metadata.bibend);
    const parsed = entries.length
      ? (new DOMParser().parseFromString(htmlStr.join(''), 'text/html').body
          .firstChild as HTMLElement)
      : null;

    const result: FileCache = {
      keys: citeKeys,
      resolvedKeys,
      unresolvedKeys,
      bib: parsed,
      citations,
      citeBibMap,
      settings,
      source,
    };

    this.fileCache.set(file, result);
    this.dispatchResult(file, result);

    return result.bib;
  }

  dispatchResult(file: TFile, result: FileCache) {
    app.workspace.getLeavesOfType('markdown').find((l) => {
      const view = l.view as MarkdownView;
      if (view.file === file) {
        const renderer = (view.previewMode as any).renderer;
        if (renderer) {
          renderer.lastText = null;
          for (const section of renderer.sections) {
            if (
              !section.el.hasClass('mod-header') &&
              !section.el.hasClass('mod-footer')
            ) {
              section.rendered = false;
              section.el.empty();
            }
          }
          renderer.queueRender();
        }

        const cm = (view.editor as any).cm as EditorView;
        if (cm.dispatch) {
          cm.dispatch({
            effects: [setCiteKeyCache.of(result)],
          });
        }
      }
    });
  }

  getCacheForPath(filePath: string) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file && file instanceof TFile && this.fileCache.has(file)) {
      const cache = this.fileCache.get(file);
      return cache;
    }

    return null;
  }

  getResolution(filePath: string, key: string) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file && file instanceof TFile && this.fileCache.has(file)) {
      const cache = this.fileCache.get(file);
      return {
        isResolved: cache.resolvedKeys.has(key),
        isUnresolved: cache.unresolvedKeys.has(key),
      };
    }

    return {
      isResolved: false,
      isUnresolved: false,
    };
  }

  getCitationsForSection(filePath: string, lineStart: number, lineEnd: number) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file && file instanceof TFile && this.fileCache.has(file)) {
      const cache = this.fileCache.get(file);
      const mCache = app.metadataCache.getCache(filePath);

      const section = mCache.sections?.find(
        (s) =>
          s.position.start.line === lineStart && s.position.end.line === lineEnd
      );

      if (!section) return [];

      const startOffset = section.position.start.offset;
      const endOffset = section.position.end.offset;

      const cites = cache.citations.filter(
        (c) => c.from >= startOffset && c.to <= endOffset
      );
      return cites;
    }

    return [];
  }
}