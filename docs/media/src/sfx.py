"""The feed cut's sounds, made from sine tones and filtered noise: no samples, no music.

mix(cues, seconds) lays each cue, [t, name], on one track and returns 16-bit stereo at RATE, shaped (samples, 2).
Every sound is short and quiet; the loudest, the stuck alert, peaks near -10 dBFS.
"""
import numpy as np

RATE = 48000
MASTER = 8  # dB over each sound's own level
rng = np.random.default_rng(7)  # the same small variations on every encode


def span(sec):
    return np.arange(int(sec * RATE)) / RATE


def norm(x):
    return x / (np.max(np.abs(x)) or 1)


def level(x, db):
    return norm(x) * 10 ** ((db + MASTER) / 20)


def band(x, lo, hi):
    """Keeps lo to hi Hz, with soft edges."""
    f = np.fft.rfftfreq(len(x), 1 / RATE)
    mid, half = (lo + hi) / 2, (hi - lo) / 2
    return np.fft.irfft(np.fft.rfft(x) / (1 + ((f - mid) / half) ** 4), len(x))


def tone(freq, sec, decay, attack=0.002):
    t = span(sec)
    return np.sin(2 * np.pi * freq * t) * np.exp(-t / decay) * np.minimum(1, t / attack)


def burst(sec, decay, lo, hi):
    t = span(sec)
    return band(rng.standard_normal(len(t)), lo, hi) * np.exp(-t / decay)


def bell(freq, sec=1.2):
    return tone(freq, sec, 0.35) + 0.35 * tone(2.01 * freq, sec, 0.18) + 0.15 * tone(3.02 * freq, sec, 0.1)


def lay(*parts):
    """Sounds placed at offsets in seconds, summed."""
    out = np.zeros(max(int(o * RATE) + len(x) for o, x in parts))
    for o, x in parts:
        i = int(o * RATE)
        out[i:i + len(x)] += x
    return out


def swish(sec=0.6):
    """Air that rises and falls over a ring's 0.55 s draw."""
    t = span(sec)
    return norm(band(rng.standard_normal(len(t)), 2500, 9000) * np.sin(np.pi * t / sec) ** 2)


def key():
    j = rng.uniform(0.85, 1.15)
    return level(norm(burst(0.05, 0.005, 2000 * j, 6000 * j)) + 0.4 * norm(tone(190 * j, 0.05, 0.008)), -31 + rng.uniform(-2, 2))


def space():
    return level(norm(burst(0.06, 0.008, 900, 3000)) + 0.5 * norm(tone(150, 0.06, 0.012)), -31)


def enter():
    return level(norm(burst(0.08, 0.01, 1000, 4000)) + 0.6 * norm(tone(130, 0.08, 0.015)), -26)


def click():
    """A mouse button, down then up."""
    down = norm(burst(0.03, 0.0025, 2500, 8000)) + 0.5 * norm(tone(2400, 0.03, 0.004))
    return level(lay((0, down), (0.075, 0.55 * down)), -20)


def tick():
    """A tool call finished."""
    return level(tone(1568, 0.12, 0.03) + 0.25 * tone(3136, 0.12, 0.018), -31)


def glide(start, end, sec, fall, decay, attack=0.002):
    """A tone whose pitch drops from start to end Hz, quickly (fall is the time constant)."""
    t = span(sec)
    f = end + (start - end) * np.exp(-t / fall)
    return np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.exp(-t / decay) * np.minimum(1, t / attack)


def deny():
    """A call refused, or a check that failed: one dull, damped knock."""
    return level(norm(glide(300, 180, 0.14, 0.02, 0.045)) + 0.4 * norm(burst(0.14, 0.006, 300, 1500)), -23)


def ring_blue():
    return lay((0, level(swish(), -38)), (0.45, level(tone(988, 0.6, 0.2) + 0.3 * tone(1976, 0.6, 0.1), -32)))


def ring_red():
    return lay((0, level(swish(), -38)), (0.45, level(tone(330, 0.5, 0.15, 0.006) + 0.7 * tone(392, 0.5, 0.13, 0.006), -27)))


def ring_green():
    return lay((0, level(swish(), -38)), (0.42, level(bell(1047), -26)), (0.52, level(bell(1319), -27)))


def alert():
    """The run goes stuck: two short buzzes at one pitch, rough from a partner a semitone up. No falling notes, which
    is how the system sounds for a device going away."""
    def buzz(sec=0.09):
        t = span(sec)
        x = sum(np.sin(2 * np.pi * k * 294 * t) / k for k in (1, 3, 5)) + 0.4 * np.sin(2 * np.pi * 311 * t)
        return x * np.minimum(1, t / 0.004) * np.minimum(1, (sec - t) / 0.02)
    return level(lay((0, buzz()), (0.13, buzz())), -18)


def toast():
    """A short pop, rising."""
    t = span(0.09)
    f = 700 + 600 * np.minimum(1, t / 0.05)
    return level(np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.exp(-t / 0.03) * np.minimum(1, t / 0.002), -27)


def chapter():
    """A new chapter: a card slid into place, a short brush of friction that ends in a soft, low knock."""
    t = span(0.13)
    brush = band(rng.standard_normal(len(t)), 1200, 5000) * (t / 0.13) ** 2
    knock = norm(glide(150, 80, 0.3, 0.03, 0.07, 0.003)) + 0.3 * norm(burst(0.3, 0.01, 400, 1800))
    return lay((0, level(brush, -32)), (0.12, level(knock, -21)))


def intro():
    """The opening card: three soft bells rising, E5, G5, C6, in the family of the end chime."""
    return lay((0, level(bell(659, 1.4), -28)), (0.09, level(bell(784, 1.4), -27)), (0.18, level(bell(1047, 1.6), -24)))


def chime():
    """The end card: C6, then G6."""
    return lay((0, level(bell(1047), -23)), (0.14, level(bell(1568), -24)))


SOUNDS = {'key': key, 'space': space, 'enter': enter, 'click': click, 'tick': tick, 'deny': deny, 'ring-blue': ring_blue,
          'ring-red': ring_red, 'ring-green': ring_green, 'alert': alert, 'toast': toast, 'chapter': chapter, 'intro': intro, 'chime': chime}


def settle(cues):
    """One sound per event. A ring that starts within 0.6 s after a terminal sound (a call finishing, a refusal, a toast)
    marks the same moment on the dashboard, so the ring plays alone."""
    rings = [t for t, n in cues if n.startswith('ring-')]
    return [(t, n) for t, n in cues if not (n in ('tick', 'deny', 'toast') and any(-0.1 <= r - t <= 0.6 for r in rings))]


def mix(cues, seconds):
    cues = settle(cues)
    out = np.zeros(int(seconds * RATE))
    for t, name in cues:
        x, i = SOUNDS[name](), int(t * RATE)
        x = x[:max(0, len(out) - i)]
        out[i:i + len(x)] += x
    out[-int(0.05 * RATE):] *= np.linspace(1, 0, int(0.05 * RATE))
    peak = np.max(np.abs(out))
    if peak > 0.89:
        out *= 0.89 / peak
    print(f'audio: {len(cues)} cues, peak {20 * np.log10(max(peak, 1e-9)):.1f} dBFS')
    pcm = (out * 32767).astype(np.int16)
    return np.stack([pcm, pcm], axis=1)
