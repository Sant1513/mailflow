'use client';

import CodeMirror from '@uiw/react-codemirror';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';

export function CodeEditor({
  value,
  onChange,
  language,
  height = '100%',
}: {
  value: string;
  onChange: (next: string) => void;
  language: 'html' | 'css';
  height?: string;
}) {
  return (
    <CodeMirror
      value={value}
      height={height}
      extensions={[language === 'html' ? htmlLang() : cssLang()]}
      onChange={onChange}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: true }}
      style={{ fontSize: 12, height: '100%' }}
    />
  );
}
