plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "in.yash0.cd.sample"
    compileSdk = 35
    defaultConfig { applicationId = "in.yash0.cd.sdk.sample"; minSdk = 29; targetSdk = 35; versionCode = 1; versionName = "0.1.0-preview.1" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies { implementation(project(":transfer")) }
