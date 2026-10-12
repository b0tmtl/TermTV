// Boot helpers in plain ES5: they must run even if the app bundle fails on an old TV.
    (function () {
      var sp = document.getElementById('splash');
      var el = document.getElementById('boot-error');
      function show(msg) {
        // The app removes the splash once it runs; bring it back to show later errors.
        if (!sp.parentNode) document.body.appendChild(sp);
        el.textContent += msg + '\n';
        if (el.textContent.indexOf('Browser:') < 0) el.textContent += 'Browser: ' + navigator.userAgent + '\n(Report this on GitHub. Press Back or Exit to close.)\n';
      }
      window.__termtvBootError = show;
      var steps = document.getElementById('boot-steps');
      // The app calls this at each startup stage, so a hang shows where it stopped.
      window.__termtvBootStep = function (name) {
        steps.textContent += '> ' + name + '\n';
      };
      window.__termtvBootStep('boot');
      window.onerror = function (msg, src, line, col, err) {
        show('Error: ' + msg + ' (' + String(src).split('/').pop() + ':' + line + ':' + col + ')' + (err && err.stack ? '\n' + err.stack.split('\n').slice(0, 4).join('\n') : ''));
      };
      window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        show('Unhandled: ' + (r && (r.stack || r.message) || r));
      });
      document.addEventListener('keydown', function (e) {
        if (e.keyCode === 10009 && sp.parentNode && el.textContent) {
          try { tizen.application.getCurrentApplication().exit(); } catch (x) {}
        }
      });
      setTimeout(function () {
        if (sp.parentNode && !el.textContent) {
          show('Still loading after 20 s: the app did not start.');
        }
      }, 20000);
    })();
