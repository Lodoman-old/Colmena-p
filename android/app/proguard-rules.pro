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

# Biometric plugin (clases cargadas por reflexión desde capacitor.plugins.json)
-keep class com.epicshaggy.biometric.** { *; }
-keep class androidx.biometric.** { *; }

# App nativa (paquete actual)
-keep class com.prioridadterritorial.app.** { *; }

# Métodos y anotaciones de plugins Capacitor
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public *;
}

# Keep annotations used by Capacitor reflection
-keepattributes *Annotation*, JavascriptInterface
