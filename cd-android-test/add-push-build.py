from pathlib import Path
p=Path('android/app/build.gradle.kts');s=p.read_text();s=s.replace('plugins {','buildscript {\n    if (providers.gradleProperty("cdFcm").orNull == "true") {\n        repositories { google(); mavenCentral() }\n        dependencies { classpath("com.google.gms:google-services:4.5.0") }\n    }\n}\nplugins {',1)
s=s.replace('val cdAbi =', '''val cdFcmValue = providers.gradleProperty("cdFcm").orNull
require(cdFcmValue == null || cdFcmValue in setOf("true", "false")) { "cdFcm must be true or false" }
val cdFcm = cdFcmValue == "true"
if (cdFcm) {
    require(file("google-services.json").isFile) { "cdFcm=true requires android/app/google-services.json from your Firebase Android app (in.yash0.cd). See android/docs/push.md." }
    apply(plugin = "com.google.gms.google-services")
}
val cdAbi =''')
s=s.replace('sourceSets["test"].resources.srcDir', '''sourceSets["main"].java.srcDir(if (cdFcm) "src/fcm/kotlin" else "src/noFcm/kotlin")
    if (cdFcm) sourceSets["main"].manifest.srcFile("src/fcm/AndroidManifest.xml")
    sourceSets["test"].resources.srcDir''')
s=s.replace('    implementation("com.squareup.okhttp3:okhttp:4.12.0")','    implementation("com.squareup.okhttp3:okhttp:4.12.0")\n    if (cdFcm) implementation("com.google.firebase:firebase-messaging:26.0.0")')
p.write_text(s)
p=Path('android/.gitignore');s=p.read_text();p.write_text(s+'\napp/google-services.json\npush-build-log.txt\n')
