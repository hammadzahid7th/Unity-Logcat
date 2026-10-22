using UnityEngine;

/// <summary>
/// Drop this file anywhere in Assets/. Call these from your game code so the
/// Unity Logcat PM tool can measure level times and attribute crashes/ANRs to levels.
/// Works in release builds too (Debug.Log goes to logcat).
///
/// Tip: Project Settings > Player > Other Settings > "Stack Trace Logging" -> set
/// Error / Exception / Warning (and Log, if you want stacks on logs) to "ScriptOnly"
/// so every error in the tool comes with a C# stack trace.
/// </summary>
public static class PMLog
{
    public static void LevelStart(object levelId)    => Debug.Log($"[PM] LEVEL_START {levelId}");
    public static void LevelComplete(object levelId) => Debug.Log($"[PM] LEVEL_COMPLETE {levelId}");
    public static void LevelFail(object levelId)     => Debug.Log($"[PM] LEVEL_FAIL {levelId}");

    /// <summary>Any custom milestone: PMLog.Event("tutorial_done"), PMLog.Event("ad_shown interstitial")</summary>
    public static void Event(string name)            => Debug.Log($"[PM] EVENT {name}");
}
