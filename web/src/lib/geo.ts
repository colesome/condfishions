/** Get the phone's location with clear, iPhone-specific error messages. */
export function getPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Location isn't available on this device."));
      return;
    }
    const ok = (p: GeolocationPosition) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
    const fail = (e: GeolocationPositionError, retried: boolean) => {
      if (e.code === e.TIMEOUT && !retried) {
        navigator.geolocation.getCurrentPosition(ok, (e2) => fail(e2, true),
          { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
        return;
      }
      reject(new Error(message(e)));
    };
    navigator.geolocation.getCurrentPosition(ok, (e) => fail(e, false),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60_000 });
  });
}

function message(e: GeolocationPositionError): string {
  switch (e.code) {
    case e.PERMISSION_DENIED:
      return "Location is blocked. On your iPhone open Settings → Privacy & Security → Location Services → "
        + "Safari Websites → choose \"While Using the App\" (and check Location Services is on). "
        + "Then close and reopen CondFishions and tap Allow when asked.";
    case e.POSITION_UNAVAILABLE:
      return "Your phone couldn't work out where you are. Try again with Wi-Fi on or somewhere with better signal.";
    default:
      return "Finding your location took too long. Try again in a moment.";
  }
}
