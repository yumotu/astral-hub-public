import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAssistantArtifacts, assistantCopyText } from '../shared/assistant-artifacts.mjs';

test('ordinary Markdown explanations including headings/lists remain unframed text', () => {
  const intro = '我是DSH助手。\n\n## 我能做什么\n- 文件\n- 终端\n\n```md\n# 示例\n```';
  assert.deepEqual(splitAssistantArtifacts(intro), [{ kind: 'text', text: intro }]);
});

test('explicit finished manuscripts are separated from surrounding discussion', () => {
  assert.deepEqual(
    splitAssistantArtifacts(
      '以下是文稿。\n:::writing{variant="document" title="讲义"}\n# 检索\n\n正文\n:::\n你可以修改。',
    ),
    [
      { kind: 'text', text: '以下是文稿。\n' },
      { kind: 'artifact', variant: 'document', title: '讲义', text: '# 检索\n\n正文' },
      { kind: 'text', text: '你可以修改。' },
    ],
  );
});

test('streaming, malformed, empty or unsupported markers keep original text intact', () => {
  for (const text of [
    ':::writing{variant="document"}\n:::',
    ':::writing{variant="unknown"}\ntext\n:::',
    ':::writing{variant="document" onclick=alert(1)}\ntext\n:::',
    'inline :::writing{variant="document"}\ntext\n:::',
  ])
    assert.deepEqual(splitAssistantArtifacts(text), [{ kind: 'text', text }]);
});

test('code fences can contain literal markers or closing lines without being interpreted', () => {
  const code = '```md\n:::writing{variant="document"}\n文稿示例\n:::\n```';
  assert.deepEqual(splitAssistantArtifacts(code), [{ kind: 'text', text: code }]);
  const body = '```md\n:::\n```\n文稿';
  assert.deepEqual(splitAssistantArtifacts(':::writing{variant="document"}\n' + body + '\n:::'), [
    { kind: 'artifact', variant: 'document', title: '', text: body },
  ]);
});

test('multiple artifacts preserve sequence and safely retain title characters as data', () => {
  const text =
    ':::writing{variant="email" title="<script>"}\n邮件\n:::\n中间\n:::writing{variant="standard"}\n第二份\n:::\n';
  const parts = splitAssistantArtifacts(text);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['artifact', 'text', 'artifact'],
  );
  assert.equal(parts[0].title, '<script>');
  assert.equal(parts[2].text, '第二份');
});

test('valid in-progress writing blocks show only body until closed', () => {
  assert.deepEqual(
    splitAssistantArtifacts('前言\n:::writing{variant="document" title="草稿"}\n# 正在生成'),
    [{ kind: 'text', text: '前言\n# 正在生成' }],
  );
  assert.deepEqual(splitAssistantArtifacts(':::writing{variant="document"}\n'), []);
});

test('streamed openers are hidden and whole-reply copies omit presentation controls', () => {
  for (const tail of [':::writing', ':::writing{', ':::writing{variant="document" title="']) {
    assert.deepEqual(splitAssistantArtifacts('前言\n' + tail), [{ kind: 'text', text: '前言\n' }]);
  }
  assert.equal(
    assistantCopyText('前言\n:::writing{variant="document"}\n# 成品\n:::\n说明'),
    '前言\n\n# 成品\n说明',
  );
  const code = '```md\n:::writing{variant="document"}\n示例\n:::\n```';
  assert.equal(assistantCopyText(code), code);
});
