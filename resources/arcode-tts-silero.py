"""
Reads text aloud with Silero for ARcode's voice chat, on this Mac only.

ARcode starts this script once with the Python of a virtual environment that has `silero` and
`torch` installed, and keeps it running. Each request is one JSON line on stdin:
    {"text": "...", "speaker": "baya", "out": "/path/to/file.wav"}
and each answer one JSON line on stdout: {"ok": true} or {"ok": false, "error": "..."}.
The model is loaded once; Silero downloads it on the very first start and works offline after that.
"""
import json
import sys


def main() -> None:
    try:
        import torch
        from silero import silero_tts

        torch.set_num_threads(4)
        model, _ = silero_tts(language="ru", speaker="v5_ru")
        speakers = [s for s in model.speakers if s != "random"]
    except Exception as error:  # noqa: BLE001 - reported to ARcode, which shows it
        print(json.dumps({"ok": False, "error": f"Silero could not start: {error}"}), flush=True)
        return
    print(json.dumps({"ok": True, "ready": True, "speakers": speakers}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            speaker = request.get("speaker") if request.get("speaker") in speakers else speakers[0]
            model.save_wav(
                text=str(request["text"]),
                speaker=speaker,
                sample_rate=48000,
                audio_path=str(request["out"]),
                put_accent=True,
                put_yo=True,
                put_stress_homo=True,
                put_yo_homo=True,
            )
            print(json.dumps({"ok": True}), flush=True)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": str(error)[:300]}), flush=True)


if __name__ == "__main__":
    main()
