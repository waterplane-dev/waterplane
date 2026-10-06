/**
 * The Offline & data group's last two rows: the door into Downloads, and how
 * big an image is when it goes UP (the picker is the one the annotator shows).
 */
import { Download } from "lucide-react";
import { core } from "../../sdk";
import { SetAction, SetCustom } from "../../SettingsKit";
import { isNativeShell } from "../../hostUrl";
import { UploadScalePicker } from "../../UploadScalePicker";
import { track } from "../../usage";

export function PullSettings() {
  return (
    <>
      <SetAction
        id="downloads" label="downloads" icon={Download} opens
        onClick={() => { track("overlay:pull"); core().nav.open("pull"); }}
        note="Every file this app fetches, plus which files a repo produces get fetched on their own."
        more={<p>Wherever the tap came from — the gallery, a build's artifacts, a notification. Transfers resume from where a dropped link left them, so a build finishes even across dead spots{isNativeShell()
          ? ", though in this app they only run while it is open — the browser version keeps them going with the app closed"
          : ", and in an installed Chrome they keep going with the app closed"}.</p>}
      />

      <SetCustom
        id="upload-scale" label=""
        note={<>Applies to images going UP (annotator, camera, multi-select). <b>auto</b> picks the width from the measured upload rate.</>}
        more={<p>A slow link gets a smaller image instead of a minute of blocked Send. The same picker sits above the annotator's send buttons.</p>}
      >
        <UploadScalePicker />
      </SetCustom>
    </>
  );
}
