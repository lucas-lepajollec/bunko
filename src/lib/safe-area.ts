/**
 * iOS 26.1+ Home Screen apps (WebKit bug 301994): the page is drawn under the status bar, which
 * the system now covers with a frosted layer, but `env(safe-area-inset-top)` reports 0. The top
 * of every screen (header, reader and player bars) then sits under the status bar, blurred and
 * out of reach. When that happens the boot script below gives `--app-safe-top` the status bar
 * height of the device instead; everywhere else the real inset is kept.
 */

/** Portrait status bar height (CSS px) of iPhones, by their longest screen side. */
export const IPHONE_STATUS_BAR: Record<number, number> = {
  956: 62,
  874: 62,
  932: 59,
  852: 59,
  896: 48,
  926: 47,
  844: 47,
  812: 47,
};

export function statusBarFallback(longSide: number): number {
  return IPHONE_STATUS_BAR[longSide] ?? (longSide >= 852 ? 59 : longSide >= 812 ? 47 : 20);
}

/**
 * Runs before the first paint and on every resize. It only acts in an installed iPhone app, in
 * portrait, when the page covers the whole screen and the reported inset is 0.
 */
export const SAFE_AREA_BOOT_SCRIPT = `(function(){try{var n=navigator,d=document.documentElement;if(!/iPhone|iPod/.test(n.userAgent))return;if(!(n.standalone===true||matchMedia('(display-mode: standalone)').matches))return;var M=${JSON.stringify(
  IPHONE_STATUS_BAR,
)};var p=document.createElement('div');p.setAttribute('aria-hidden','true');p.style.cssText='position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)';function fix(){if(!p.isConnected)d.appendChild(p);var env=parseFloat(getComputedStyle(p).paddingTop)||0;var h=Math.max(screen.width,screen.height);var full=h-innerHeight<30;var fb=env>0||innerWidth>innerHeight||!full?0:(M[h]||(h>=852?59:h>=812?47:20));if(fb){d.style.setProperty('--app-safe-top',fb+'px');d.dataset.safeTop='fallback';}else{d.style.removeProperty('--app-safe-top');delete d.dataset.safeTop;}}fix();addEventListener('resize',fix);addEventListener('orientationchange',fix);}catch(e){}})();`;
