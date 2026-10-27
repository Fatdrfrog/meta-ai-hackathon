let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;

  const AudioContextConstructor =
    window.AudioContext ||
    (
      window as Window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;

  if (!AudioContextConstructor) return null;
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContextConstructor();
  }
  return sharedAudioContext;
}

function playTone(
  context: AudioContext,
  startAt: number,
  frequency: number,
  gainValue: number,
  durationSeconds: number
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(gainValue, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSeconds + 0.02);
}

export function playConversationNotificationSound(): void {
  try {
    const context = getAudioContext();
    if (!context) return;

    const play = () => {
      const startAt = context.currentTime;
      playTone(context, startAt, 880, 0.035, 0.09);
      playTone(context, startAt + 0.11, 1174.66, 0.028, 0.08);
    };

    if (context.state === "suspended") {
      void context
        .resume()
        .then(play)
        .catch(() => undefined);
      return;
    }

    play();
  } catch {
    // Browser audio policies are best-effort for inbox notifications.
  }
}
