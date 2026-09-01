plugins {
    id("com.android.application")
}

android {
    namespace = "com.lightreader.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.lightreader.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "0.1.3"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
