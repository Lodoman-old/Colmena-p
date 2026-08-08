# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Capacitor bridge
-keep class com.getcapacitor.** { *; }
-keep class com.getcapacitor.plugin.** { *; }
-keep class com.getcapacitor.community.** { *; }
-keep class com.colmena.** { *; }

# Keep WebView JS interfaces
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Biometric plugin
-keep class androidx.biometric.** { *; }

# Keep annotations used by Capacitor reflection
-keepattributes *Annotation*, JavascriptInterface
