import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { unifiedMergeView } from '@codemirror/merge';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: tags.string, color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-literal)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--code-function)',
  },
  { tag: [tags.typeName, tags.className], color: 'var(--code-type)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.heading, tags.strong], fontWeight: '600' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);
export type CodeSelection = { text: string; startLine: number; endLine: number };
export default function CodeEditor(props: {
  path: string;
  content: string;
  readOnly: boolean;
  original?: string;
  onChange: (text: string) => void;
  onSelect: (selection: CodeSelection | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null),
    callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => {
    const language = /\.py$/.test(props.path)
      ? python()
      : /\.[cm]?[jt]sx?$/.test(props.path)
        ? javascript({ typescript: /\.tsx?$/.test(props.path), jsx: /[jt]sx$/.test(props.path) })
        : /\.md$/i.test(props.path)
          ? markdown()
          : /\.json$/i.test(props.path)
            ? json()
            : [];
    const view = new EditorView({
      parent: root.current!,
      state: EditorState.create({
        doc: props.content,
        extensions: [
          basicSetup,
          syntaxHighlighting(codeHighlight),
          language,
          EditorState.readOnly.of(props.readOnly),
          EditorView.editable.of(!props.readOnly),
          EditorView.contentAttributes.of({
            'aria-label': props.readOnly ? '文件内容' : '文件编辑器',
            tabindex: '0',
          }),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: '12px',
              backgroundColor: 'var(--surface)',
              color: 'var(--text)',
            },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            },
            '.cm-gutters': {
              backgroundColor: 'var(--surface-alt, var(--bg))',
              color: 'var(--muted)',
              borderColor: 'var(--border)',
            },
            '.cm-activeLineGutter': {
              backgroundColor: 'var(--surface-active)',
              color: 'var(--text)',
            },
            '.cm-content': { padding: '14px 0' },
            '.cm-activeLine': { backgroundColor: 'var(--hover)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-cursor': { borderLeftColor: 'var(--accent)' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
              backgroundColor: 'var(--selection)',
            },
            '.cm-insertedLine': { backgroundColor: '#21a66b15' },
            '.cm-deletedChunk': { backgroundColor: '#ef444412' },
            '.cm-changedText': { backgroundColor: '#56b88724' },
          }),
          ...(props.original !== undefined
            ? unifiedMergeView({
                original: props.original,
                mergeControls: false,
                collapseUnchanged: { margin: 4, minSize: 12 },
                diffConfig: { scanLimit: 1000 },
              })
            : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const range = update.state.selection.main;
              callbacks.current.onSelect(
                range.empty
                  ? null
                  : {
                      text: update.state.sliceDoc(range.from, range.to).slice(0, 5000),
                      startLine: update.state.doc.lineAt(range.from).number,
                      endLine: update.state.doc.lineAt(Math.max(range.from, range.to - 1)).number,
                    },
              );
            }
          }),
        ],
      }),
    });
    editor.current = view;
    const nativeSelection = () => {
      const selected = window.getSelection();
      if (
        !selected?.anchorNode ||
        !selected.focusNode ||
        !view.contentDOM.contains(selected.anchorNode) ||
        !view.contentDOM.contains(selected.focusNode)
      )
        return;
      try {
        const a = view.posAtDOM(selected.anchorNode, selected.anchorOffset),
          b = view.posAtDOM(selected.focusNode, selected.focusOffset),
          from = Math.min(a, b),
          to = Math.max(a, b);
        callbacks.current.onSelect(
          from === to
            ? null
            : {
                text: view.state.sliceDoc(from, to).slice(0, 5000),
                startLine: view.state.doc.lineAt(from).number,
                endLine: view.state.doc.lineAt(Math.max(from, to - 1)).number,
              },
        );
      } catch {
        callbacks.current.onSelect(null);
      }
    };
    document.addEventListener('selectionchange', nativeSelection);
    return () => {
      document.removeEventListener('selectionchange', nativeSelection);
      editor.current = null;
      view.destroy();
    };
  }, [props.path, props.readOnly, props.original]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.content)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.content } });
  }, [props.content]);
  return <div className="workbench-editor" ref={root} />;
}
