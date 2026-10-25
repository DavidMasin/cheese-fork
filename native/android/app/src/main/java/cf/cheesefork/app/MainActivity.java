package cf.cheesefork.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DayWidgetPlugin.class);
        registerPlugin(MoodleBackgroundPlugin.class);
        registerPlugin(MoodleSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
