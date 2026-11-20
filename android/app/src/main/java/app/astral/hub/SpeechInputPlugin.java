package app.astral.hub;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

@CapacitorPlugin(name = "AstralSpeech", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class SpeechInputPlugin extends Plugin {
    private SpeechRecognizer recognizer;
    private String activeId;
    private boolean requesting;
    private String pendingId;
    boolean isCapturing() { return activeId != null || requesting; }

    @PluginMethod public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }
    @PluginMethod public void start(PluginCall call) {
        String id = call.getString("id", "");
        if (!id.matches("[a-fA-F0-9-]{36}")) { call.reject("语音请求编号不正确。"); return; }
        if (requesting || activeId != null) { call.reject("系统语音服务正忙。"); return; }
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) { call.reject("当前系统没有语音识别服务，可使用键盘听写。"); return; }
        requesting = true;
        pendingId = id;
        if (getPermissionState("microphone") != PermissionState.GRANTED)
            requestPermissionForAlias("microphone", call, "microphonePermission");
        else begin(call);
    }
    @PermissionCallback private void microphonePermission(PluginCall call) {
        if (!requesting || !call.getString("id", "").equals(pendingId)) { call.reject("语音输入已取消。"); return; }
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call);
        else { requesting = false; pendingId = null; call.reject("麦克风权限未允许，请在系统设置中检查。"); }
    }
    private void emit(String id, String text, boolean done, String error, boolean ended) {
        JSObject event = new JSObject(); event.put("id", id);
        if (text != null) event.put("text", text.length() > 12000 ? text.substring(0,12000) : text);
        if (done) event.put("final", true);
        if (error != null) event.put("error", error);
        if (ended) event.put("ended", true);
        notifyListeners("speech", event);
    }
    private String transcript(Bundle result) {
        ArrayList<String> list = result == null ? null : result.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return list == null || list.isEmpty() ? "" : list.get(0);
    }
    private void release() {
        activeId = null;
        if (recognizer != null) { recognizer.cancel(); recognizer.destroy(); recognizer = null; }
    }
    private void begin(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!requesting || !call.getString("id", "").equals(pendingId)) { call.reject("语音输入已取消。"); return; }
            requesting = false;
            pendingId = null;
            final String id = call.getString("id");
            activeId = id;
            try {
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(new RecognitionListener() {
                    private boolean live() { return id.equals(activeId); }
                    public void onReadyForSpeech(Bundle params) {}
                    public void onBeginningOfSpeech() {}
                    public void onRmsChanged(float rms) {}
                    public void onBufferReceived(byte[] buffer) {}
                    public void onEndOfSpeech() {}
                    public void onEvent(int type, Bundle params) {}
                    public void onPartialResults(Bundle result) { if (live()) emit(id, transcript(result), false, null, false); }
                    public void onResults(Bundle result) { if (live()) { emit(id, transcript(result), true, null, true); release(); } }
                    public void onError(int code) {
                        if (!live()) return;
                        String reason = code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "not-allowed"
                            : code == SpeechRecognizer.ERROR_AUDIO ? "audio-capture"
                            : code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "no-speech"
                            : code == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? "busy"
                            : code == SpeechRecognizer.ERROR_NETWORK || code == SpeechRecognizer.ERROR_NETWORK_TIMEOUT ? "network"
                            : code == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || code == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ? "language-not-supported" : "unavailable";
                        emit(id, null, false, reason, true); release();
                    }
                });
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                String language = call.getString("language", "zh-CN");
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US".equals(language) ? "en-US" : "zh-CN");
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                recognizer.startListening(intent);
                call.resolve();
            } catch (Exception e) { release(); call.reject("语音服务启动失败，请检查系统语音服务。"); }
        });
    }
    @PluginMethod public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (call.getString("id", "").equals(pendingId)) { requesting = false; pendingId = null; }
            if (call.getString("id", "").equals(activeId)) {
                if (Boolean.TRUE.equals(call.getBoolean("cancel", false))) release();
                else if (recognizer != null) recognizer.stopListening();
            }
            call.resolve();
        });
    }
    @Override protected void handleOnPause() { getActivity().runOnUiThread(() -> { requesting = false; pendingId = null; release(); }); }
    @Override protected void handleOnDestroy() { requesting = false; pendingId = null; release(); }
}
