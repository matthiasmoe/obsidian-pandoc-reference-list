import { syntaxTree } from '@codemirror/language';
import { tokenClassNodeProp } from '@codemirror/language';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { Tree } from '@lezer/common';
import {
  editorInfoField,
  editorLivePreviewField,
  livePreviewState,
} from 'obsidian';

import {
  RenderedCitation,
  Segment,
  SegmentType,
  getCitationSegments,
} from './parser/parser';
import { BibManager, FileCache } from './bib/bibManager';
import equal from 'fast-deep-equal';

const ignoreListRegEx = /code|math|templater|hashtag/;

const citeMark = (
  citekey: string,
  sourceFile: string | undefined,
  isResolved: boolean,
  isUnresolved: boolean
) => {
  const cls = ['cm-pandoc-citation', 'pandoc-citation'];

  if (isResolved) cls.push('is-resolved');
  if (isUnresolved) cls.push('is-unresolved');

  return Decoration.mark({
    class: cls.join(' '),
    attributes: {
      'data-citekey': citekey,
      'data-source': sourceFile || '',
    },
  });
};

const citeMarkFormatting = (type: string) => {
  return Decoration.mark({
    class: `cm-pandoc-citation-formatting ${type}`,
  });
};

const citeMarkExtra = (type: string) => {
  return Decoration.mark({
    class: `cm-pandoc-citation-extra ${type}`,
  });
};

class CiteWidget extends WidgetType {
  cite: RenderedCitation;
  sourcePath?: string;

  constructor(cite: RenderedCitation, sourcePath?: string) {
    super();
    this.cite = cite;
    this.sourcePath = sourcePath;
  }

  eq(widget: this): boolean {
    return this.cite === widget.cite;
  }

  toDOM() {
    const attr = {
      'data-citekey': this.cite.citations.map((c) => c.id).join('|'),
      'data-source': this.sourcePath,
    };

    return createSpan(
      {
        cls: 'pandoc-citation is-resolved',
        attr: attr,
      },
      (span) => {
        if (/</.test(this.cite.val)) {
          const parsed = new DOMParser().parseFromString(
            this.cite.val,
            'text/html'
          );
          span.append(parsed.body.firstChild);
        } else {
          span.setText(this.cite.val);
        }
      }
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const citeDeco = (cite: RenderedCitation, sourcePath?: string) =>
  Decoration.replace({
    widget: new CiteWidget(cite, sourcePath),
  });

function onlyValType(segs: Segment[]) {
  return segs.map((s) => ({ type: s.type, val: s.val }));
}

export const citeKeyPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.mkDeco(view);
    }
    update(update: ViewUpdate) {
      if (
        update.viewportChanged ||
        update.docChanged ||
        update.transactions.some((tr) =>
          tr.effects.some(
            (e) =>
              e.is(setCiteKeyCache) || e.value?.field === editorLivePreviewField
          )
        ) ||
        (update.view.state.field(editorLivePreviewField) &&
          update.selectionSet &&
          !update.view.plugin(livePreviewState)?.mousedown)
      ) {
        this.decorations = this.mkDeco(update.view);
      }
    }
    mkDeco(view: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      const obsView = view.state.field(editorInfoField);
      const citekeyCache = view.state.field(citeKeyCacheField);
      const isLivePreview = view.state.field(editorLivePreviewField);

      // Don't get the syntax tree until we have to
      let tree: Tree;

      for (const { from, to } of view.visibleRanges) {
        const range = view.state.sliceDoc(from, to);
        const segments = getCitationSegments(range);

        for (const match of segments) {
          if (!tree) tree = syntaxTree(view.state);

          if (isLivePreview) {
            const rendered = citekeyCache?.citations.find((c) =>
              equal(onlyValType(c?.data || []), onlyValType(match))
            );

            if (rendered) {
              const start = match[0].from;
              const end = match[match.length - 1].to;
              if (
                view.state.selection.ranges.every((r) => {
                  return (
                    !(start >= r.from && end <= r.to) &&
                    !(
                      (r.from >= start && r.from <= end) ||
                      (r.to >= start && r.to <= end)
                    )
                  );
                })
              ) {
                b.add(start, end, citeDeco(rendered, obsView?.file.path));
                continue;
              }
            }
          }

          for (let i = 0, len = match.length; i < len; i++) {
            const part = match[i];
            const next = match[i + 1];
            const start = from + part.from;
            const end = from + part.to;

            const nodeProps = tree
              .resolveInner(start, 1)
              .type.prop(tokenClassNodeProp);

            if (nodeProps && ignoreListRegEx.test(nodeProps)) {
              break;
            }

            switch (part.type) {
              case SegmentType.key: {
                const isUnresolved =
                  !nodeProps?.includes('link') &&
                  citekeyCache?.unresolvedKeys.has(part.val);
                const isResolved = citekeyCache?.resolvedKeys.has(part.val);

                b.add(
                  start,
                  end,
                  citeMark(
                    part.val,
                    obsView?.file.path,
                    isResolved,
                    isUnresolved
                  )
                );
                continue;
              }
              case SegmentType.at: {
                const isUnresolved =
                  !!next &&
                  !nodeProps?.includes('link') &&
                  citekeyCache?.unresolvedKeys.has(next.val);
                const isResolved =
                  !!next && citekeyCache?.resolvedKeys.has(next.val);

                const classes: string[] = [part.type];

                if (isUnresolved) classes.push('is-unresolved');
                if (isResolved) classes.push('is-resolved');

                b.add(start, end, citeMarkFormatting(classes.join(' ')));
                continue;
              }
              case SegmentType.curlyBracket:
              case SegmentType.bracket:
                b.add(start, end, citeMarkFormatting(part.type));
                continue;
              case SegmentType.separator:
              case SegmentType.suppressor:
              case SegmentType.prefix:
              case SegmentType.suffix:
              case SegmentType.locator:
              case SegmentType.locatorLabel:
              case SegmentType.locatorSuffix:
                b.add(start, end, citeMarkExtra(part.type));
                continue;
            }
          }
        }
      }

      return b.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

export const setCiteKeyCache = StateEffect.define<FileCache>();
export const citeKeyCacheField = StateField.define<FileCache>({
  create(state) {
    const obsView = state.field(editorInfoField);
    const bibManager = state.field(bibManagerField);

    if (obsView?.file && bibManager?.fileCache.has(obsView.file)) {
      return bibManager.fileCache.get(obsView.file);
    }

    return null;
  },
  update(state, tr) {
    for (const e of tr.effects) {
      if (e.is(setCiteKeyCache)) {
        state = e.value;
      }
    }

    return state;
  },
});

export const bibManagerField = StateField.define<BibManager>({
  create() {
    return null;
  },
  update(state) {
    return state;
  },
});
