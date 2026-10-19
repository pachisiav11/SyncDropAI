package com.syncdrop.ai;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Map;

/**
 * Receives the relay's "mail is waiting" push.
 *
 * Firebase starts this service even when the app was swiped out of recents,
 * which is the case the keep-alive service cannot cover. The push carries only
 * the sender's device id, never a file name: the file is still sealed on the
 * relay, and only the app can open it.
 *
 * A running app is told to collect at once. Unless it is on screen, a "File
 * waiting" notice goes up as well: off screen, the system may have frozen the
 * page, and then nothing would show until the app was opened. The page's own
 * "File received" notice replaces it once the file is in.
 */
public class PushService extends FirebaseMessagingService {

    private static final String PREFS = "push";
    private static final String PEERS = "peers";
    private static final String COUNT_PREFIX = "waiting:";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (!"mail".equals(data.get("type"))) return;
        String from = data.get("sender");

        if (NotifyPlugin.deliverMail()) return;

        Notifications.createChannels(this);
        SharedPreferences prefs = prefs(this);
        int count = prefs.getInt(COUNT_PREFIX + from, 0) + 1;
        prefs.edit().putInt(COUNT_PREFIX + from, count).apply();
        Notifications.waiting(this, from, peerName(this, from), count);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        NotifyPlugin.deliverToken(token);
    }

    /** Called once a file from this sender has arrived, so its waiting notice can go. */
    static void received(Context context, String fromId) {
        if (fromId == null) return;
        prefs(context).edit().remove(COUNT_PREFIX + fromId).apply();
        Notifications.cancelWaiting(context, fromId);
    }

    /** The web layer's paired devices, so a push can name its sender. */
    static void rememberPeers(Context context, JSONArray peers) {
        prefs(context).edit().putString(PEERS, peers.toString()).apply();
    }

    private static String peerName(Context context, String deviceId) {
        try {
            JSONArray peers = new JSONArray(prefs(context).getString(PEERS, "[]"));
            for (int i = 0; i < peers.length(); i++) {
                JSONObject peer = peers.getJSONObject(i);
                if (peer.optString("deviceId").equals(deviceId)) {
                    String name = peer.optString("name").trim();
                    if (!name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // A list that does not parse names nobody.
        }
        return "a paired device";
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
