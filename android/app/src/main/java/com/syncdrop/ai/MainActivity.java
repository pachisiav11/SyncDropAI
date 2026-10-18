package com.syncdrop.ai;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(SaveFilePlugin.class);
        registerPlugin(NotifyPlugin.class);
        super.onCreate(savedInstanceState);

        Notifications.createChannels(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        // Started here because Android only lets an app start a foreground
        // service while it is itself in the foreground.
        ContextCompat.startForegroundService(this, new Intent(this, KeepAliveService.class));
    }

    @Override
    public void onDestroy() {
        // Back on the last screen finishes the activity and the WebView with it.
        if (isFinishing()) stopService(new Intent(this, KeepAliveService.class));
        super.onDestroy();
    }
}
