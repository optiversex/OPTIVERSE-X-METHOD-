plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "store.optiversex.method"
    compileSdk = 34

    defaultConfig {
        applicationId = "store.optiversex.method"
        minSdk = 29          // Android 10+ (saving to Movies via MediaStore needs no extra permission)
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release.keystore")
            storePassword = "optiversex"
            keyAlias = "optiversex"
            keyPassword = "optiversex"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    // libffmpeg.so is a real executable: it must be unpacked to nativeLibraryDir so it can be started.
    packaging { jniLibs { useLegacyPackaging = true } }
    androidResources { noCompress += listOf("mp4", "jpg", "png", "ico", "js", "html") }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
}
