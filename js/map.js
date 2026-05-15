/**
 * China Administrative Map — Core Engine
 * Province → City → County drill-down with ECharts 5 + DataV GeoJSON
 */
(function (global) {
  'use strict';

  var CONFIG = {
    DATA_URL: 'https://geo.datav.aliyun.com/areas_v3/bound/',
    CHINA_ADCODE: '100000',
    CHINA_NAME: '中国',
    OVERPASS_URL: 'https://overpass.kumi.systems/api/interpreter'
  };

  var COLORS = [
    '#c2dcc2', '#b3d1d9', '#d4c5e0', '#f2ddb8', '#bdd4e8',
    '#e0c8c8', '#c1ddd0', '#d6c0dc', '#e4dec0', '#bcccdb',
    '#c8dcc8', '#b8d4d0', '#d8ccdc', '#eedcc0', '#c4d4e8'
  ];

  var state = {
    chart: null,
    domId: null,
    navStack: [],
    currentIndex: -1,
    geoCache: new Map(),
    showHighways: true,
    loading: false,
    townshipGeoCache: new Map()
  };

  // Hash name to a stable color from the palette
  function colorFor(name) {
    var h = 0, i;
    for (i = 0; i < name.length; i++) {
      h = ((h << 5) - h) + name.charCodeAt(i);
      h |= 0;
    }
    return COLORS[Math.abs(h) % COLORS.length];
  }

  function showLoading() {
    state.loading = true;
    var el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'flex';
  }

  function hideLoading() {
    state.loading = false;
    var el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  }

  function getLevel(gj) {
    if (!gj || !gj.features || !gj.features.length) return '';
    var l = gj.features[0].properties.level;
    if (l === 'country') return 'province';
    if (l === 'township') return 'township';
    return l || '';
  }

  // District→township is handled by drillDownToTownship, not drillDown
  function canDrill(lv) {
    return lv === 'province' || lv === 'city' || lv === 'district';
  }

  function labelSize(lv) {
    if (lv === 'township') return 7;
    if (lv === 'district') return 9;
    if (lv === 'city') return 11;
    return 13;
  }

  function findFeature(gj, name) {
    var fs = gj.features;
    for (var i = 0; i < fs.length; i++) {
      if (fs[i].properties.name === name) return fs[i];
    }
    return null;
  }

  async function loadGeoJSON(adcode) {
    if (state.geoCache.has(adcode)) return state.geoCache.get(adcode);
    var url = CONFIG.DATA_URL + adcode + '_full.json';
    var resp = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var json = await resp.json();
    state.geoCache.set(adcode, json);
    return json;
  }

  function pointDist(a, b) {
    var dx = a[0] - b[0];
    var dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Stitch OSM ways into closed rings by matching endpoints (~100m tolerance)
  function stitchWaysIntoRings(ways) {
    if (ways.length === 0) return [];
    if (ways.length === 1) {
      var ring = ways[0].map(function(p) { return [p[0], p[1]]; });
      var f = ring[0], l = ring[ring.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
      return [ring];
    }

    var used = new Array(ways.length).fill(false);
    var eps = ways.map(function(w) {
      return { start: w[0], end: w[w.length - 1] };
    });
    var rings = [];
    var TOL = 0.001;

    function findMatch(pt) {
      var best = -1, bestD = TOL, rev = false;
      for (var i = 0; i < ways.length; i++) {
        if (used[i]) continue;
        var ds = pointDist(pt, eps[i].start);
        var de = pointDist(pt, eps[i].end);
        if (ds < bestD) { best = i; bestD = ds; rev = false; }
        if (de < bestD) { best = i; bestD = de; rev = true; }
      }
      return best >= 0 ? { index: best, reverse: rev } : null;
    }

    // Snip duplicate endpoint when appending
    function appendRing(ring, way, rev) {
      var i, p;
      if (rev) {
        for (i = way.length - 1; i >= 0; i--) {
          p = [way[i][0], way[i][1]];
          var last = ring[ring.length - 1];
          if (pointDist(p, last) < TOL) continue;
          ring.push(p);
        }
      } else {
        for (i = 0; i < way.length; i++) {
          p = [way[i][0], way[i][1]];
          var last = ring[ring.length - 1];
          if (pointDist(p, last) < TOL) continue;
          ring.push(p);
        }
      }
    }

    function prependRing(ring, way, rev) {
      var i, p;
      if (rev) {
        for (i = 0; i < way.length; i++) {
          p = [way[i][0], way[i][1]];
          if (pointDist(p, ring[0]) < TOL) continue;
          ring.unshift(p);
        }
      } else {
        for (i = way.length - 1; i >= 0; i--) {
          p = [way[i][0], way[i][1]];
          if (pointDist(p, ring[0]) < TOL) continue;
          ring.unshift(p);
        }
      }
    }

    for (var si = 0; si < ways.length; si++) {
      if (used[si]) continue;
      var ring = [];
      for (var k = 0; k < ways[si].length; k++) {
        ring.push([ways[si][k][0], ways[si][k][1]]);
      }
      used[si] = true;

      // Grow tail
      var grown = true;
      while (grown) {
        grown = false;
        var m = findMatch(ring[ring.length - 1]);
        if (m) { used[m.index] = true; appendRing(ring, ways[m.index], m.reverse); grown = true; }
      }
      // Grow head
      grown = true;
      while (grown) {
        grown = false;
        var m = findMatch(ring[0]);
        if (m) { used[m.index] = true; prependRing(ring, ways[m.index], m.reverse); grown = true; }
      }

      // Close ring
      var f = ring[0], l = ring[ring.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);

      if (ring.length >= 4) rings.push(ring);
    }

    return rings;
  }

  function overpassToGeoJSON(data) {
    var features = [];
    var elements = data.elements || [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.type !== 'relation') continue;
      var tags = el.tags || {};
      if (!tags.name || tags.admin_level !== '8') continue;

      var members = el.members || [];
      // Collect outer-way coordinate arrays
      var wayCoords = [];
      for (var j = 0; j < members.length; j++) {
        var m = members[j];
        if (m.role !== 'outer' || m.type !== 'way') continue;
        var geom = m.geometry;
        if (!geom || geom.length < 3) continue;
        var coords = [];
        for (var k = 0; k < geom.length; k++) {
          coords.push([geom[k].lon, geom[k].lat]);
        }
        wayCoords.push(coords);
      }

      if (wayCoords.length === 0) continue;

      var rings = stitchWaysIntoRings(wayCoords);
      if (rings.length === 0) continue;

      var geometry;
      if (rings.length === 1) {
        geometry = { type: 'Polygon', coordinates: [rings[0]] };
      } else {
        geometry = { type: 'MultiPolygon', coordinates: rings.map(function(r) { return [r]; }) };
      }

      var adcode = tags['ref:admin:CN:nbs'] || tags['ref:admin:CN:mca'] || String(el.id);

      features.push({
        type: 'Feature',
        properties: {
          name: tags.name,
          adcode: adcode,
          level: 'township',
          adminType: tags['admin_type:CN'] || ''
        },
        geometry: geometry
      });
    }
    return { type: 'FeatureCollection', features: features };
  }

  function escapeOverpass(str) {
    return str.replace(/[\\";\[\]]/g, '\\$&');
  }

  async function loadOSMTownships(countyName) {
    if (state.townshipGeoCache.has(countyName)) {
      return state.townshipGeoCache.get(countyName);
    }
    var query = '[out:json][timeout:90];' +
      'area["name"="' + escapeOverpass(countyName) + '"][admin_level=6][boundary=administrative];' +
      'rel[admin_level=8][boundary=administrative](area);' +
      'out geom;';

    var controller = new AbortController();
    var to = setTimeout(function () { controller.abort(); }, 100000);

    try {
      var resp = await fetch(CONFIG.OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: query,
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      clearTimeout(to);
      if (!resp.ok) throw new Error('Overpass HTTP ' + resp.status);
      var data = await resp.json();
      var geoJSON = overpassToGeoJSON(data);
      if (geoJSON.features.length === 0) {
        throw new Error('No townships found for ' + countyName);
      }
      state.townshipGeoCache.set(countyName, geoJSON);
      return geoJSON;
    } catch (e) {
      clearTimeout(to);
      if (e.name === 'AbortError') {
        throw new Error('Overpass query timed out for ' + countyName);
      }
      throw e;
    }
  }

  // ---------- ECharts option builder ----------

  function buildOption(gj, adcode) {
    var features = gj.features;
    var lv = getLevel(gj);
    var ls = labelSize(lv);
    var drill = canDrill(lv);

    var TOWN_COLORS = [
      '#fde0dd', '#fce4d6', '#fff3cd', '#e8f5e9', '#e3f2fd',
      '#f3e5f5', '#fce4ec', '#e0f2f1', '#fff8e1', '#ede7f6'
    ];
    function townColor(name) {
      var h = 0, i;
      for (i = 0; i < name.length; i++) {
        h = ((h << 5) - h) + name.charCodeAt(i);
        h |= 0;
      }
      return TOWN_COLORS[Math.abs(h) % TOWN_COLORS.length];
    }
    var paletteFn = lv === 'township' ? townColor : colorFor;

    var regions = features.map(function (f) {
      return {
        name: f.properties.name,
        itemStyle: { areaColor: paletteFn(f.properties.name) }
      };
    });

    // Build a name→adcode lookup for tooltip formatter
    var adcMap = {};
    features.forEach(function (f) {
      adcMap[f.properties.name] = f.properties.adcode;
    });

    var opt = {
      backgroundColor: '#f2f4f7',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(40,40,40,0.92)',
        borderColor: '#555',
        textStyle: { color: '#fff', fontSize: 13 },
        formatter: function (p) {
          if (!p.name) return '';
          var h = '<strong style="font-size:14px">' + p.name + '</strong>';
          var a = adcMap[p.name];
          if (a != null) h += '<br/>代码: ' + a;
          if (lv === 'township') {
            h += '<br/><span style="color:#aaa;font-size:11px">乡镇级 (OSM)</span>';
          } else {
            h += '<br/><span style="color:#bbb;font-size:11px">' +
                 (drill ? '点击下钻' : '已是末级') + '</span>';
          }
          return h;
        }
      },
      geo: {
        map: String(adcode),
        roam: true,
        scaleLimit: { min: 1, max: 40 },
        regions: regions,
        label: {
          show: true,
          fontSize: ls,
          color: '#444',
          textShadowColor: '#fff',
          textShadowBlur: 3
        },
        itemStyle: {
          areaColor: '#e8e8e8',
          borderColor: '#ffffff',
          borderWidth: lv === 'township' ? 1 : 1.5
        },
        emphasis: {
          label: {
            color: '#000',
            fontWeight: 'bold',
            fontSize: Math.min(ls + 4, 18)
          },
          itemStyle: {
            areaColor: '#ffd54f',
            borderColor: '#444',
            borderWidth: 2,
            shadowBlur: 12,
            shadowColor: 'rgba(0,0,0,0.3)'
          }
        }
      },
      series: []
    };

    // Highway overlay via lines series on geo coordinate system
    var hw = global.HighwayData;
    if (state.showHighways && hw && hw.length) {
      opt.series.push({
        name: '国道',
        type: 'lines',
        coordinateSystem: 'geo',
        geoIndex: 0,
        polyline: true,
        silent: true,
        data: hw.map(function (h) {
          return { name: h.name, coords: h.coords };
        }),
        lineStyle: {
          color: '#ff8f00',
          width: 1.5,
          opacity: 0.55
        },
        zlevel: 1
      });
    }

    return opt;
  }

  // ---------- Render ----------

  function renderMap(gj, adcode) {
    var mapName = String(adcode);
    echarts.registerMap(mapName, gj);

    // Stash on function object so click handler can reference current data
    renderMap._gj = gj;
    renderMap._lv = getLevel(gj);

    var opt = buildOption(gj, adcode);

    if (!state.chart) {
      var dom = document.getElementById(state.domId);
      if (!dom) { console.error('Map container not found'); return; }
      state.chart = echarts.init(dom);

      state.chart.on('click', function (p) {
        if (p.componentType !== 'geo') return;
        var curGj = renderMap._gj;
        var curLv = renderMap._lv;
        if (!curGj) return;
        var feat = findFeature(curGj, p.name);
        if (!feat) return;
        if (curLv === 'district') {
          drillDownToTownship(feat.properties.adcode, feat.properties.name);
        } else if (canDrill(curLv)) {
          drillDown(feat.properties.adcode, feat.properties.name);
        }
      });

      window.addEventListener('resize', function () {
        if (state.chart) state.chart.resize();
      });
    }

    // Clear view so new GeoJSON auto-fits to correct bounds
    state.chart.clear();
    state.chart.setOption(opt, true);
  }

  // ---------- Navigation ----------

  async function drillDown(adcode, name) {
    if (state.loading) return;
    showLoading();
    try {
      var gj = await loadGeoJSON(adcode);
      state.navStack.push({ adcode: adcode, name: name, geoJSON: gj });
      state.currentIndex = state.navStack.length - 1;
      renderMap(gj, adcode);
      updateBreadcrumb();
      fadeInfoTip();
    } catch (e) {
      alert('无法加载 "' + name + '" 的地图数据。\n该区域暂无下级行政区数据。');
      console.error('Drill-down failed:', e);
    } finally {
      hideLoading();
    }
  }

  async function drillDownToTownship(adcode, name) {
    if (state.loading) return;
    showLoading();
    try {
      var gj = await loadOSMTownships(name);
      state.navStack.push({ adcode: adcode, name: name, geoJSON: gj });
      state.currentIndex = state.navStack.length - 1;
      renderMap(gj, adcode);
      updateBreadcrumb();
      fadeInfoTip();
    } catch (e) {
      var msg = e.message || '';
      if (msg.indexOf('timed out') >= 0) {
        alert('"' + name + '" 查询超时。\nOverpass 服务器繁忙，请稍后重试。');
      } else if (msg.indexOf('No townships') >= 0) {
        alert('"' + name + '" 暂无乡镇级数据。\nOSM 尚未覆盖该区域的乡镇边界。');
      } else {
        alert('"' + name + '" 查询失败。\n' + (msg || '请检查网络后重试。'));
      }
      console.error('Township drill failed:', e);
    } finally {
      hideLoading();
    }
  }

  async function goBack() {
    if (state.navStack.length <= 1 || state.loading) return;
    state.navStack.pop();
    state.currentIndex = state.navStack.length - 1;
    var cur = state.navStack[state.currentIndex];
    renderMap(cur.geoJSON, cur.adcode);
    updateBreadcrumb();
    fadeInfoTip();
  }

  async function goToLevel(idx) {
    if (idx === state.currentIndex || state.loading) return;
    state.navStack = state.navStack.slice(0, idx + 1);
    state.currentIndex = idx;
    var cur = state.navStack[idx];
    renderMap(cur.geoJSON, cur.adcode);
    updateBreadcrumb();
    fadeInfoTip();
  }

  function updateBreadcrumb() {
    var bc = document.getElementById('breadcrumb');
    if (!bc) return;
    var h = '';
    state.navStack.forEach(function (item, idx) {
      if (idx === state.navStack.length - 1) {
        h += '<span class="breadcrumb-current">' + item.name + '</span>';
      } else {
        h += '<a href="#" class="breadcrumb-link" data-index="' + idx + '">' +
             item.name + '</a>';
        h += '<span class="breadcrumb-separator">&rsaquo;</span>';
      }
    });
    bc.innerHTML = h;
    bc.querySelectorAll('.breadcrumb-link').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        goToLevel(parseInt(this.dataset.index, 10));
      });
    });
    var bb = document.getElementById('back-btn');
    if (bb) bb.style.display = state.navStack.length > 1 ? 'inline-flex' : 'none';
  }

  function fadeInfoTip() {
    var tip = document.getElementById('info-tip');
    if (!tip) return;
    tip.classList.add('fade');
    clearTimeout(tip._timeout);
    tip._timeout = setTimeout(function () { tip.classList.remove('fade'); }, 3000);
  }

  // ---------- Public API ----------

  function toggleHighways() {
    state.showHighways = !state.showHighways;
    var cur = state.navStack[state.currentIndex];
    if (cur) renderMap(cur.geoJSON, cur.adcode);
    var btn = document.getElementById('highway-toggle');
    if (btn) {
      btn.classList.toggle('active', state.showHighways);
      btn.textContent = state.showHighways ? '国道: 开' : '国道: 关';
    }
  }

  global.ChinaMap = {
    init: async function (domId) {
      state.domId = domId;
      showLoading();
      try {
        var gj = await loadGeoJSON(CONFIG.CHINA_ADCODE);
        state.navStack = [{
          adcode: CONFIG.CHINA_ADCODE,
          name: CONFIG.CHINA_NAME,
          geoJSON: gj
        }];
        state.currentIndex = 0;
        renderMap(gj, CONFIG.CHINA_ADCODE);
        updateBreadcrumb();
        fadeInfoTip();
      } catch (e) {
        alert('加载中国地图数据失败，请检查网络后刷新。');
        console.error('Init failed:', e);
      } finally {
        hideLoading();
      }
    },
    goBack: goBack,
    goToLevel: goToLevel,
    toggleHighways: toggleHighways
  };

})(window);
