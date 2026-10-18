package com.syncdrop.ai;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Holds the app in the foreground state while it is off screen.
 *
 * Receiving happens in the WebView, so all this service has to do is exist:
 * without it Android freezes the process and cuts its network a few seconds
 * after another app takes over, and a file sent from the laptop waits on the
 * relay until SyncDrop is opened again.
 *
 * Swiping the app away destroys the WebView, after which there is nothing left
 * to keep alive, so the service stops with the task.
 */
public class KeepAliveService extends Service {

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(Notifications.KEEP_ALIVE_ID, Notifications.keepAlive(this),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(Notifications.KEEP_ALIVE_ID, Notifications.keepAlive(this));
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
