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
    return l === 'country' ? 'province' : (l || '');
  }

  function canDrill(lv) {
    return lv === 'province' || lv === 'city';
  }

  function labelSize(lv) {
    return lv === 'district' ? 9 : lv === 'city' ? 11 : 13;
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

  function overpassToGeoJSON(data) {
    var features = [];
    var elements = data.elements || [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.type !== 'relation') continue;
      var tags = el.tags || {};
      if (!tags.name || tags.admin_level !== '8') continue;

      var members = el.members || [];
      var rings = [];

      for (var j = 0; j < members.length; j++) {
        var m = members[j];
        if (m.role !== 'outer') continue;
        var geom = m.geometry;
        if (!geom || geom.length < 3) continue;

        var coords = [];
        for (var k = 0; k < geom.length; k++) {
          coords.push([geom[k].lon, geom[k].lat]);
        }
        var first = coords[0];
        var last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          coords.push([first[0], first[1]]);
        }
        rings.push(coords);
      }

      if (rings.length === 0) continue;

      var geometry;
      if (rings.length === 1) {
        geometry = { type: 'Polygon', coordinates: rings };
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
    var query = '[out:json][timeout:30];' +
      'area["name"="' + escapeOverpass(countyName) + '"][admin_level=6][boundary=administrative];' +
      'rel[admin_level=8][boundary=administrative](area);' +
      'out geom;';
    var resp = await fetch(CONFIG.OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: query,
      referrerPolicy: 'no-referrer'
    });
    if (!resp.ok) throw new Error('Overpass HTTP ' + resp.status);
    var data = await resp.json();
    var geoJSON = overpassToGeoJSON(data);
    if (geoJSON.features.length === 0) {
      throw new Error('No townships found for ' + countyName);
    }
    state.townshipGeoCache.set(countyName, geoJSON);
    return geoJSON;
  }

  // ---------- ECharts option builder ----------

  function buildOption(gj, adcode) {
    var features = gj.features;
    var lv = getLevel(gj);
    var ls = labelSize(lv);
    var drill = canDrill(lv);

    var regions = features.map(function (f) {
      return {
        name: f.properties.name,
        itemStyle: { areaColor: colorFor(f.properties.name) }
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
          h += '<br/><span style="color:#bbb;font-size:11px">' +
               (drill ? '点击下钻' : '已是末级') + '</span>';
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
          borderWidth: 1.5
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
    if (!echarts.getMap(mapName)) {
      echarts.registerMap(mapName, gj);
    }

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
        if (!curGj || !canDrill(curLv)) return;
        var feat = findFeature(curGj, p.name);
        if (feat) {
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
