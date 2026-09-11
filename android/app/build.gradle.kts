plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "in.yash0.cd"
    compileSdk = 34

    defaultConfig {
        applicationId = "in.yash0.cd"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.fragment:fragment-ktx:1.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    implementation("androidx.compose.material3:material3:1.2.1")
    implementation("androidx.compose.material:material-icons-extended:1.6.7")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Camera + barcode (native QR scan, replaces html5-qrcode)
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.2.0")

    // QR generation (replaces qrcode npm)
    implementation("com.google.zxing:core:3.5.3")

    // WebRTC data channel (replaces PeerJS-in-browser, same protocol).
    // Infobip publishes the official upstream builds to Maven Central.
    // NOTE: 1.0.45036 omits org.webrtc.Environment and 1.0.48228 omits
    // PeerConnectionFactoryJni (both crash at runtime — verified on-device).
    // 1.0.43581 is self-consistent and matches this code's API.
    implementation("com.infobip:google-webrtc:1.0.43581")
    // Tiny pure-Java WebSocket for PeerJS signaling (one socket, text frames).
    implementation("org.java-websocket:Java-WebSocket:1.5.6")
    // MessagePack framing for the data channel — mandatory for web interop:
    // peerjs 'binary' serialization msgpack-packs every frame (incl. control).
    implementation("org.msgpack:msgpack-core:0.9.8")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test:1.9.24")
}
