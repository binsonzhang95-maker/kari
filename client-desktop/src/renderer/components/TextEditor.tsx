import Editor from '@monaco-editor/react';
import { Save } from 'lucide-react';
import type { ReadFileResult } from '../../shared/types';

interface TextEditorProps {
  file: ReadFileResult;
  content: string;
  dirty: boolean;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

export function TextEditor({ file, content, dirty, saving, onChange, onSave }: TextEditorProps) {
  return (
    <section className="editor-shell">
      <div className="editor-status">
        <div>
          <span className="eyebrow">TEXT MONITOR</span>
          <strong>{file.relPath}</strong>
        </div>
        <div className="editor-actions">
          <span className={dirty ? 'dirty-dot dirty-dot--on' : 'dirty-dot'} />
          <span>{dirty ? 'modified' : 'synced buffer'}</span>
          <button className="primary-small" onClick={onSave} disabled={!dirty || saving}>
            <Save size={15} />
            <span>{saving ? 'saving' : 'save + sync'}</span>
          </button>
        </div>
      </div>
      <div className="editor-frame">
        <Editor
          path={file.path}
          value={content}
          language={file.language}
          theme="vs-dark"
          onChange={(value) => onChange(value || '')}
          options={{
            fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            lineNumbers: 'on',
            minimap: { enabled: false },
            overviewRulerBorder: false,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            automaticLayout: true,
            padding: { top: 16, bottom: 16 }
          }}
        />
      </div>
    </section>
  );
}

