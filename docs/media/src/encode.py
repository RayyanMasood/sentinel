"""Packs a folder of PNG frames into a clip: python encode.py <frames> <out> <fps>.

<out>.webp is an animated WebP for the README. A frame the same as the one before only lengthens it, so the long holds
cost nothing. Key frames are off (kmax=0), so each frame stores only what changed since the last; by default Pillow
writes a whole frame every 3 to 5.

<out>.mp4 is H.264 for a video post, encoded with the libx264 that PyAV carries, a frame at a time.
"""
import glob
import os
import sys

from PIL import Image, ImageChops

src, out, fps = sys.argv[1], sys.argv[2], int(sys.argv[3])
files = sorted(glob.glob(os.path.join(src, '*.png')))

if out.endswith('.mp4'):
    import json
    from fractions import Fraction

    import av

    cues_file = os.path.join(src, 'sounds.json')
    cues = json.load(open(cues_file)) if os.path.exists(cues_file) else []
    with av.open(out, 'w', container_options={'movflags': '+faststart'}) as box:
        video = box.add_stream('libx264', rate=fps, options={'crf': '16', 'preset': 'slow'})
        video.codec_context.width, video.codec_context.height = Image.open(files[0]).size
        video.codec_context.pix_fmt = 'yuv420p'
        # The sound cues the scene gathered become an AAC track (sfx.py). The container writes its header with the
        # first frame, so the stream is added before it.
        if cues:
            import sfx

            audio = box.add_stream('aac', rate=sfx.RATE)
            audio.codec_context.layout = 'stereo'
            audio.codec_context.bit_rate = 160_000
        for f in files:
            box.mux(video.encode(av.VideoFrame.from_image(Image.open(f).convert('RGB'))))
        box.mux(video.encode())
        if cues:
            pcm = sfx.mix(cues, len(files) / fps)
            for i in range(0, len(pcm), 4800):
                frame = av.AudioFrame.from_ndarray(pcm[i:i + 4800].reshape(1, -1), format='s16', layout='stereo')
                frame.sample_rate, frame.pts, frame.time_base = sfx.RATE, i, Fraction(1, sfx.RATE)
                box.mux(audio.encode(frame))
            box.mux(audio.encode())
    print(f'{os.path.basename(out)}: {len(files)} frames, {os.path.getsize(out) / 1e6:.1f} MB')
    sys.exit()

step = round(1000 / fps)
frames, durations = [], []
for f in files:
    im = Image.open(f).convert('RGB')
    if frames and ImageChops.difference(im, frames[-1]).getbbox() is None:
        durations[-1] += step
        continue
    frames.append(im)
    durations.append(step)
frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0, quality=88, method=6, kmin=0, kmax=0)
print(f'{os.path.basename(out)}: {len(frames)} frames, {os.path.getsize(out) / 1e6:.1f} MB')
