#!/usr/bin/env bash
# Builds a native ffmpeg 5.1 (same major version as the website's engine) with x264 and libzimg for Android arm64,
# and installs it as app/src/main/jniLibs/arm64-v8a/libffmpeg.so  (an executable that the app starts).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_ROOT:-}}}"
[ -d "$NDK" ] || { echo "Android NDK not found (set ANDROID_NDK_HOME)"; exit 1; }
API=29
TOOL="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
TARGET=aarch64-linux-android
CC="$TOOL/bin/${TARGET}${API}-clang"; CXX="$TOOL/bin/${TARGET}${API}-clang++"
AR="$TOOL/bin/llvm-ar"; RANLIB="$TOOL/bin/llvm-ranlib"; STRIP="$TOOL/bin/llvm-strip"; NM="$TOOL/bin/llvm-nm"
W="$ROOT/build-ffmpeg"; PREFIX="$W/prefix"; mkdir -p "$W" "$PREFIX"; cd "$W"
JOBS=$(nproc)

echo "=== x264 (stable branch = core 164, like the website's engine) ==="
[ -d x264 ] || git clone --depth 1 --branch stable https://code.videolan.org/videolan/x264.git
( cd x264
  CC="$CC" AR="$AR" RANLIB="$RANLIB" STRIP="$STRIP" ./configure --prefix="$PREFIX" --host=aarch64-linux-android \
    --enable-static --enable-pic --disable-cli --disable-opencl --disable-avs --disable-swscale --disable-lavf \
    --disable-ffms --disable-gpac --disable-lsmash
  make -j"$JOBS" && make install )

ZIMG_OK=0
echo "=== zimg (HDR -> SDR tone-mapping, as in the website's engine) ==="
if [ ! -d zimg ]; then git clone --depth 1 --branch release-3.0.5 --recursive https://github.com/sekrit-twc/zimg.git || true; fi
if ( cd zimg && ./autogen.sh && CC="$CC" CXX="$CXX" AR="$AR" RANLIB="$RANLIB" ./configure --prefix="$PREFIX" \
      --host=aarch64-linux-android --enable-static --disable-shared --with-pic && make -j"$JOBS" && make install ); then
  ZIMG_OK=1
else
  echo "WARNING: zimg failed to build - continuing without HDR tone-mapping"
fi

echo "=== ffmpeg 5.1.6 ==="
[ -d ffmpeg ] || git clone --depth 1 --branch n5.1.6 https://github.com/FFmpeg/FFmpeg.git ffmpeg
cd ffmpeg
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
EXTRA=(); [ "$ZIMG_OK" = 1 ] && EXTRA+=(--enable-libzimg)
./configure --prefix="$W/ff" --enable-cross-compile --target-os=android --arch=aarch64 --cpu=armv8-a \
  --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --strip="$STRIP" --nm="$NM" \
  --enable-gpl --enable-libx264 "${EXTRA[@]}" --enable-zlib --disable-autodetect \
  --enable-pie --enable-pic --disable-doc --disable-ffplay --disable-ffprobe --disable-debug --disable-network \
  --pkg-config-flags="--static" --extra-cflags="-I$PREFIX/include -O3" --extra-ldflags="-L$PREFIX/lib -static-libstdc++" \
  --extra-libs="-lm -lc++" --enable-zlib || { tail -n 40 ffbuild/config.log; exit 1; }
make -j"$JOBS"
"$STRIP" ffmpeg -o "$ROOT/app/src/main/jniLibs/arm64-v8a/libffmpeg.so"
ls -la "$ROOT/app/src/main/jniLibs/arm64-v8a/libffmpeg.so"
echo "zimg=$ZIMG_OK"
