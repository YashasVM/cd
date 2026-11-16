plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
}
group = "in.yash0.cd"
version = "0.1.0-preview.1"
android {
    namespace = "in.yash0.cd.transfer"
    compileSdk = 35
    defaultConfig { minSdk = 29 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["test"].resources.srcDir("../../fixtures")
    testOptions.unitTests.all {
        System.getenv("CD_SDK_RELAY")?.let { value -> it.environment("CD_SDK_RELAY", value) }
    }
    publishing { singleVariant("release") { withSourcesJar() } }
}
dependencies {
    api("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
}
afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                artifactId = "transfer-android"
                pom {
                    name.set("CD Android transfer SDK")
                    description.set("Live encrypted transfers with host-owned consent and storage")
                    url.set("https://github.com/YashasVM/cd")
                    licenses { license { name.set("MIT"); url.set("https://opensource.org/licenses/MIT") } }
                    scm { url.set("https://github.com/YashasVM/cd") }
                }
            }
        }
        repositories { maven { name = "preview"; url = layout.buildDirectory.dir("repository").get().asFile.toURI() } }
    }
}
