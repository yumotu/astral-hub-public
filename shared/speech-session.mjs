export function speechError(code) {
  return ({
    'not-allowed': '麦克风或语音识别权限未允许，请在系统或浏览器设置中检查权限。',
    'service-not-allowed': '当前系统未允许此语音服务，请使用系统键盘听写。',
    'audio-capture': '没有可用麦克风，请检查输入设备。',
    network: '语音服务连接失败，已保留现有草稿；可重试或使用系统键盘听写。',
    'no-speech': '没有识别到语音，请靠近麦克风后重试。',
    'language-not-supported': '当前语音服务不支持此语言，请更换系统识别语言。',
    busy: '系统语音服务正忙，请稍后重试。',
    unavailable: '当前客户端没有可用语音识别服务，可使用系统键盘听写或支持语音识别的浏览器。',
  })[code] || '语音识别未完成，已保留现有草稿。';
}

export function createBrowserSpeech(Recognition, { lang = 'zh-CN', partial, result, error, end }) {
  const recognition = new Recognition();
  let active = true, delivered = '', ended = false;
  const finish = () => {
    if (!active || ended) return;
    ended = true;
    end();
  };
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    if (!active || ended) return;
    const values = Array.from(event.results);
    const text = values.map((r) => r[0]?.transcript || '').join(' ').trim().slice(0, 12000);
    partial(text);
    if (values.length && values.every((r) => r.isFinal) && text && text !== delivered) {
      delivered = text;
      result(text);
    }
  };
  recognition.onerror = (event) => {
    if (!active || ended) return;
    if (event.error !== 'aborted') error(speechError(event.error));
    finish();
  };
  recognition.onend = finish;
  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    abort() {
      active = false;
      recognition.onresult = recognition.onerror = recognition.onend = null;
      recognition.abort();
    },
  };
}
