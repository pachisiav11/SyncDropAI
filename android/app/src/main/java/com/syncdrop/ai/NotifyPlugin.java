package com.syncdrop.ai;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lets the web layer post a "File received" notice once a file has fully arrived. */
@CapacitorPlugin(name = "Notify")
public class NotifyPlugin extends Plugin {

    @PluginMethod
    public void received(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.trim().isEmpty()) name = "A file";
        Notifications.received(getContext(), call.getString("id"), name, call.getString("from"));
        call.resolve();
    }
}
