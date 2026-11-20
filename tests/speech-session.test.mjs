import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSpeech, speechError } from '../shared/speech-session.mjs';

test('speech partials stay separate, final text is inserted once and cancelled sessions cannot leak to another draft', () => {
  let engine;
  class Recognition {
    constructor() { engine = this; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  const preview = [], draft = [], errors = [];
  let ends = 0;
  const session = createBrowserSpeech(Recognition, { lang: 'zh-CN', partial: (s) => preview.push(s), result: (s) => draft.push(s), error: (s) => errors.push(s), end: () => ends++ });
  assert.ok(!engine.started, 'creating the feature must not activate the microphone');
  session.start();
  assert.equal(engine.lang, 'zh-CN');
  const result = (text, isFinal) => ({results:[Object.assign([{transcript:text}],{isFinal})]});
  engine.onresult(result('连续',false));
  engine.onresult(result('连续补充',false));
  assert.deepEqual(draft,[]);
  engine.onresult(result('连续补充发送',true));
  engine.onresult(result('连续补充发送',true));
  assert.deepEqual(draft,['连续补充发送']);
  assert.equal(preview.at(-1),'连续补充发送');
  session.stop();
  assert.equal(engine.stopped,true);
  const stale = engine.onresult;
  session.abort();
  stale(result('不能进入另一个账号或对话',true));
  assert.deepEqual(draft,['连续补充发送']);
  assert.equal(engine.aborted,true);
  assert.deepEqual(errors,[]);
  assert.equal(ends,0);
});

test('permission and network failures finish without retry, recording or sending messages', () => {
  let engine;
  class Recognition { constructor() {engine=this;} start(){} stop(){} abort(){} }
  const errors=[],draft=[];
  let ends=0;
  const speech=createBrowserSpeech(Recognition,{partial:()=>{},result:t=>draft.push(t),error:e=>errors.push(e),end:()=>ends++});
  speech.start();
  engine.onerror({error:'not-allowed'});
  engine.onresult({results:[Object.assign([{transcript:'late result after permission error'}],{isFinal:true})]});
  engine.onend();
  assert.equal(ends,1);
  assert.match(errors[0],/权限/);
  assert.deepEqual(draft,[]);
  assert.match(speechError('network'),/现有草稿/);
  assert.match(speechError('unavailable'),/系统键盘听写/);
  speech.abort();
});
