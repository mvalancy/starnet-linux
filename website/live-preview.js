/* live-preview.js — sizes the embedded-app clip. The preview is the REAL app
   (website/app, a verbatim frontend copy booted from a seeded save) rendered in an
   iframe with a dedicated 960x660 camera viewport. The .app-clip window shows the station
   camera panel. The panel's live DOM rectangle is the crop authority so application
   layout changes cannot silently leave the public preview showing an old slice. */
(function(){
  'use strict';
  var clip = document.querySelector('.app-clip');
  var frame = document.querySelector('#live-app');
  var nativeWidth = 960;
  var stageObserver = null;
  var observedStage = null;
  if (!clip || !frame) return;
  function size(){
    var k = clip.clientWidth / nativeWidth;
    clip.style.setProperty('--appk', String(k));
  }
  function measureStage(){
    var doc;
    try { doc = frame.contentDocument; } catch (_) { return false; }
    var stage = doc && doc.querySelector('#stage');
    if (!stage) return false;
    var r = stage.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    nativeWidth = r.width;
    clip.style.setProperty('--appx', (-r.left) + 'px');
    clip.style.setProperty('--appy', (-r.top) + 'px');
    clip.style.setProperty('--app-aspect', r.width + ' / ' + r.height);
    size();
    if (typeof ResizeObserver !== 'undefined' && stage !== observedStage) {
      if (stageObserver) stageObserver.disconnect();
      stageObserver = new ResizeObserver(measureStage);
      stageObserver.observe(stage);
      observedStage = stage;
    }
    return true;
  }
  function settle(){
    var tries = 0;
    (function tick(){
      measureStage();
      if (++tries < 20) window.setTimeout(tick, 100);
    })();
  }
  size();
  frame.addEventListener('load', settle);
  if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') settle();
  window.addEventListener('resize', size);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(size).observe(clip);
})();
