package com.syncdrop.ai;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * The web layer's line to the phone's notices and to push.
 *
 * It posts a "File received" notice once a file has fully arrived, hands over
 * the FCM token the relay uses to wake the app, and passes pushes that reach a
 * running app on to the web layer.
 */
@CapacitorPlugin(name = "Notify")
public class NotifyPlugin extends Plugin {

    // Set while a WebView is up to receive events.
    private static volatile NotifyPlugin live;
    // Set while the app is on screen. A page that is alive but off screen may
    // be frozen by the system and never get to collect, so it is not trusted
    // to show the notice on its own.
    private static volatile boolean onScreen;

    @Override
    public void load() {
        live = this;
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        onScreen = true;
    }

    @Override
    protected void handleOnPause() {
        onScreen = false;
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        onScreen = false;
        if (live == this) live = null;
        super.handleOnDestroy();
    }

    /**
     * Wakes a running page to collect at once. Returns true only when the app
     * is on screen, where the page's own "File received" notice is enough.
     */
    static boolean deliverMail() {
        NotifyPlugin plugin = live;
        if (plugin == null) return false;
        plugin.emit("pushMail", new JSObject());
        return onScreen;
    }

    static void deliverToken(String token) {
        NotifyPlugin plugin = live;
        if (plugin == null) return;
        JSObject event = new JSObject();
        event.put("token", token);
        plugin.emit("pushToken", event);
    }

    // Firebase calls in on its own worker thread; the bridge wants the main one.
    private void emit(String name, JSObject event) {
        getBridge().executeOnMainThread(() -> notifyListeners(name, event));
    }

    @PluginMethod
    public void received(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.trim().isEmpty()) name = "A file";
        PushService.received(getContext(), call.getString("fromId"));
        Notifications.received(getContext(), call.getString("id"), name, call.getString("from"));
        call.resolve();
    }

    @PluginMethod
    public void pushToken(PluginCall call) {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful()) {
                    call.reject("No push token", task.getException());
                    return;
                }
                JSObject result = new JSObject();
                result.put("token", task.getResult());
                call.resolve(result);
            });
        } catch (IllegalStateException error) {
            // Built without google-services.json, so Firebase never started.
            call.reject("Push is not set up in this build", error);
        }
    }

    @PluginMethod
    public void peers(PluginCall call) {
        JSArray peers = call.getArray("peers", new JSArray());
        PushService.rememberPeers(getContext(), peers);
        call.resolve();
    }
}
