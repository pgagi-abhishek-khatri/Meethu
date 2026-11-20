// Meeting detector gating, kept free of Electron so it can be unit-tested.
//
// The detectors exist only to serve meeting prompts, so they follow the saved
// notification toggles: both detectors stop when meeting prompts are off, and
// process detection additionally honours its own toggle.

function deriveDetectorPreferences({
  notificationsEnabled,
  notifyMeetingDetection,
  meetingProcessDetection,
  autoStartOnDetection,
}) {
  const audioDetection = notificationsEnabled === true && notifyMeetingDetection === true;
  const result = {
    audioDetection,
    processDetection: audioDetection && meetingProcessDetection === true,
  };
  if (typeof autoStartOnDetection === "boolean") {
    result.autoStartOnDetection = autoStartOnDetection;
  }
  return result;
}

module.exports = { deriveDetectorPreferences };
