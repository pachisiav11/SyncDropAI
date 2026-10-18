package com.syncdrop.ai;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * The two kinds of notice the phone shows, kept on separate channels.
 *
 * They are separate so that switching off the "Ready to receive" notice in the
 * system settings leaves the "File received" ones alone. Android still counts a
 * foreground service whose channel is switched off as a foreground service, so
 * hiding the keep-alive notice does not let the app be put to sleep.
 */
final class Notifications {

    static final String RECEIVED_CHANNEL = "received";
    static final String KEEP_ALIVE_CHANNEL = "keep_alive";
    private static final String RECEIVED_GROUP = "com.syncdrop.ai.RECEIVED";

    static final int KEEP_ALIVE_ID = 1;
    private static final int SUMMARY_ID = 2;

    private Notifications() {
    }

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);

        NotificationChannel received = new NotificationChannel(
            RECEIVED_CHANNEL, "Files received", NotificationManager.IMPORTANCE_DEFAULT);
        received.setDescription("A file arrived from one of your devices");
        manager.createNotificationChannel(received);

        // MIN keeps it out of the status bar and folded at the bottom of the shade.
        NotificationChannel keepAlive = new NotificationChannel(
            KEEP_ALIVE_CHANNEL, "Ready to receive", NotificationManager.IMPORTANCE_MIN);
        keepAlive.setDescription("Keeps SyncDrop receiving after you leave the app. Safe to switch off.");
        keepAlive.setShowBadge(false);
        manager.createNotificationChannel(keepAlive);
    }

    static Notification keepAlive(Context context) {
        return new NotificationCompat.Builder(context, KEEP_ALIVE_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_syncdrop)
            .setContentTitle("Ready to receive")
            .setContentText("SyncDrop is listening for files from your devices")
            .setContentIntent(openApp(context))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .build();
    }

    /** One notice per file, stacked under a group summary so a batch reads as one entry. */
    static void received(Context context, String transferId, String name, String from) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;

        String text = from == null || from.isEmpty() ? name : name + " from " + from;
        Notification file = new NotificationCompat.Builder(context, RECEIVED_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_syncdrop)
            .setContentTitle("File received")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .setGroup(RECEIVED_GROUP)
            .build();

        Notification summary = new NotificationCompat.Builder(context, RECEIVED_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_syncdrop)
            .setContentTitle("Files received")
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .setGroup(RECEIVED_GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .build();

        try {
            manager.notify(idFor(transferId), file);
            manager.notify(SUMMARY_ID, summary);
        } catch (SecurityException ignored) {
            // The permission was revoked between the check above and here.
        }
    }

    // Kept clear of the two fixed ids above.
    private static int idFor(String transferId) {
        int hash = transferId == null ? (int) System.currentTimeMillis() : transferId.hashCode();
        return 0x1000 + (hash & 0x0FFFFFFF);
    }

    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
