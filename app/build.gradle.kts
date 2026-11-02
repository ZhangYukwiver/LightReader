plugins {
    id("com.android.application")
}

val verifyEmbeddingAssets by tasks.registering {
    doLast {
        val model = file("src/main/assets/vendor/embedding/models/bge-small-zh-v1.5/onnx/model_quantized.onnx")
        check(model.isFile && model.length() == 24010842L) {
            "缺少本地语义模型。请先执行 npm --prefix web ci 和 npm --prefix web run prepare:embedding。"
        }
    }
}
tasks.named("preBuild") { dependsOn(verifyEmbeddingAssets) }

android {
    namespace = "com.lightreader.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.lightreader.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 5
        versionName = "0.1.4"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
