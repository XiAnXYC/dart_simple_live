// 全局状态
let token = localStorage.getItem('token') || '';
let username = localStorage.getItem('username') || '';
let activeSite = 'recommend'; // recommend 或 bilibili, huya, douyu, douyin
let activeCategory = null;    // 当前选中的主分类
let activeSubCategory = null; // 当前选中的子分类
let page = 1;
let isLoading = false;
let hasMore = false;
let searchKeyword = '';
let favorites = [];          // 缓存用户关注列表：{site, roomId, title, userName, cover, userAvatar}[]

// 播放器与弹幕连接
let dp = null;
let ws = null;
let currentRoom = null;       // 当前播放房间详情：{site, roomId}
let qualities = [];           // 清晰度列表
let qrPollTimer = null;       // B站扫码轮询定时器
let qrKey = '';               // B站扫码 key
let qrB3 = '';                // B站扫码关联 buvid3
let qrB4 = '';                // B站扫码关联 buvid4
let pendingDanmakus = [];     // 弹幕缓存队列，用于节流更新DOM以防卡死主线程
let danmakuTimer = null;      // 弹幕节流定时器
let lastDrawTime = 0;         // 上一次绘制弹幕到视频画面的时间戳，用于防刷防卡顿
let blockRules = [];          // 屏蔽规则列表
let huyaRefreshTimer = null;  // 虎牙流 Token 续期定时器

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  if (token) {
    showApp();
  } else {
    showLogin();
  }

  // 绑定登录事件
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', handleLogin);

  // 绑定退出登录
  document.getElementById('logout-btn').addEventListener('submit', (e) => e.preventDefault());
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // 绑定 B站 统一操作按钮（根据状态展示为扫码或注销）
  document.getElementById('bili-login-btn').addEventListener('click', handleBiliAction);
  document.getElementById('bili-qr-refresh-btn').addEventListener('click', startBiliQRLogin);
  document.getElementById('bili-qr-close-btn').addEventListener('click', closeBiliQRModal);

  // 绑定 B站 备份手动输入 Cookie
  document.getElementById('bili-toggle-manual-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const area = document.getElementById('bili-manual-input-area');
    const isHidden = area.style.display === 'none';
    area.style.display = isHidden ? 'block' : 'none';
    document.getElementById('bili-toggle-manual-btn').innerText = isHidden ? '收起手动输入' : '手动输入 Cookie (备用)';
  });
  document.getElementById('bili-save-cookie-btn').addEventListener('click', handleSaveBiliCookie);

  // 载入本地屏蔽配置
  loadBlockRules();

  // 绑定屏蔽规则事件
  const blockSettingsBtn = document.getElementById('block-settings-nav-btn');
  if (blockSettingsBtn) {
    blockSettingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openBlockModal();
    });
  }
  const blockCloseBtn = document.getElementById('block-close-btn');
  if (blockCloseBtn) blockCloseBtn.addEventListener('click', closeBlockModal);
  const blockCancelBtn = document.getElementById('block-cancel-btn');
  if (blockCancelBtn) blockCancelBtn.addEventListener('click', closeBlockModal);
  const blockSaveBtn = document.getElementById('block-save-btn');
  if (blockSaveBtn) blockSaveBtn.addEventListener('click', saveBlockRules);

  // 导航栏事件
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      
      // 拦截弹幕屏蔽，不执行导航重置与大厅房间刷新
      if (item.id === 'block-settings-nav-btn') {
        return;
      }

      navItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const action = item.getAttribute('data-action');
      const val = item.getAttribute('data-value');

      // 点击不同站点或功能时，处理分类和搜索关键词
      activeCategory = null;
      activeSubCategory = null;

      if (action === 'site') {
        activeSite = val;
        // 如果是具体的直播平台，且搜索框里有值，我们就保留搜索，在此平台上执行搜索
        const isLiveSite = ['bilibili', 'huya', 'douyu', 'douyin'].includes(val);
        if (!isLiveSite || !document.getElementById('search-input').value.trim()) {
          searchKeyword = '';
          document.getElementById('search-input').value = '';
        }
        loadRooms(true);
      } else {
        // 点击“推荐”或“我的关注”等非具体直播平台，自动退出搜索状态
        searchKeyword = '';
        document.getElementById('search-input').value = '';
        if (action === 'favorites') {
          activeSite = 'favorites';
        }
        loadRooms(true);
      }
      
      // 在移动端点击后自动关闭侧边栏
      closeMobileSidebar();
    });
  });

  // 搜索事件
  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const triggerSearch = () => {
    const val = searchInput.value.trim();
    if (val) {
      // 优先拦截直播间地址直接解析开播并支持关注！
      const liveInfo = parseLiveUrl(val);
      if (liveInfo) {
        searchInput.value = '';
        openPlayer(liveInfo.site, liveInfo.roomId);
        return;
      }

      searchKeyword = val;
      // 如果当前不是具体的直播平台（如在推荐或收藏），默认切换到 B站 发起搜索，并高亮B站侧边栏
      if (!['bilibili', 'huya', 'douyu', 'douyin'].includes(activeSite)) {
        activeSite = 'bilibili';
        navItems.forEach(i => i.classList.remove('active'));
        const biliNavItem = document.querySelector('[data-value="bilibili"]');
        if (biliNavItem) biliNavItem.classList.add('active');
      }
      activeCategory = null;
      activeSubCategory = null;
      loadRooms(true);
    } else {
      // 搜索框为空，清除搜索，重置大厅
      searchKeyword = '';
      loadRooms(true);
    }
  };
  searchBtn.addEventListener('click', triggerSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') triggerSearch();
  });

  // 模态弹窗关闭事件
  document.getElementById('player-close-btn').addEventListener('click', closePlayer);
  document.getElementById('player-modal').addEventListener('click', (e) => {
    if (e.target.id === 'player-modal') closePlayer();
  });

  // 关注按钮事件
  document.getElementById('player-fav-btn').addEventListener('click', toggleFavorite);

  // 移动端菜单控制
  const menuToggle = document.getElementById('menu-toggle-btn');
  const sidebar = document.querySelector('.app-sidebar');
  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open')) {
      createOverlay();
    } else {
      removeOverlay();
    }
  });

  // 加载更多按钮
  document.getElementById('load-more-btn').addEventListener('click', () => {
    if (!isLoading && hasMore) {
      page++;
      loadRooms(false);
    }
  });
}

// ================= 鉴权管理 =================

function showLogin() {
  document.getElementById('login-container').style.display = 'flex';
  document.getElementById('app-container').style.display = 'none';
}

function showApp() {
  document.getElementById('login-container').style.display = 'none';
  document.getElementById('app-container').style.display = 'flex';
  document.getElementById('user-info').innerText = username;
  
  // 拉取关注列表并开始载入默认推荐房间
  loadFavoritesCount();
  updateBiliStatus(); // 载入大厅时拉取并展示 B站 登录状态与用户名
  loadRooms(true);
}

async function handleLogin(e) {
  e.preventDefault();
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  const errorDiv = document.getElementById('login-error');

  errorDiv.innerText = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (data.success) {
      token = data.token;
      username = data.username;
      localStorage.setItem('token', token);
      localStorage.setItem('username', username);
      showApp();
    } else {
      errorDiv.innerText = data.message || '登录失败';
    }
  } catch (err) {
    errorDiv.innerText = '无法连接到认证服务器';
    console.error(err);
  }
}

function handleLogout() {
  token = '';
  username = '';
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  showLogin();
}

// 封装 fetch 请求，自动追加 Token
async function fetchApi(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(url, options);
  if (res.status === 401) {
    handleLogout();
    throw new Error('Unauthorized');
  }
  return res.json();
}

// ================= 关注列表缓存与数量 =================

async function loadFavoritesCount() {
  try {
    const data = await fetchApi('/api/favorites');
    if (data.success) {
      favorites = data.favorites || [];
      document.getElementById('fav-count').innerText = favorites.length;
    }
  } catch (e) {
    console.error('Failed to load favorites', e);
  }
}

// ================= 房间列表加载 =================

async function loadRooms(reset = true) {
  if (isLoading) return;
  isLoading = true;

  const grid = document.getElementById('rooms-grid');
  const spinner = document.getElementById('loading-spinner');
  const noData = document.getElementById('no-data');
  const loadMore = document.getElementById('load-more-container');
  const categoryBar = document.getElementById('category-bar');
  const subCategoryBar = document.getElementById('sub-category-bar');

  if (reset) {
    page = 1;
    grid.innerHTML = '';
    noData.style.display = 'none';
    loadMore.style.display = 'none';
    
    // 更新手机端标题
    updateMobileTitle();
  }

  spinner.style.display = 'block';

  try {
    // 隐藏/显示分类栏（在搜索状态下，分类条需要隐藏）
    const isLiveSite = ['bilibili', 'huya', 'douyu', 'douyin'].includes(activeSite);
    if (isLiveSite && !searchKeyword) {
      if (reset && !activeCategory) {
        await loadCategories();
      }
      categoryBar.style.display = 'flex';
      subCategoryBar.style.display = activeSubCategory ? 'flex' : 'none';
    } else {
      categoryBar.style.display = 'none';
      subCategoryBar.style.display = 'none';
    }

    let url = '';
    let method = 'GET';
    let body = null;

    if (searchKeyword) {
      // 如果有搜索关键词，则执行搜索请求，站点根据当前选中的 activeSite 决定
      url = `/api/search?site=${activeSite}&keyword=${encodeURIComponent(searchKeyword)}&page=${page}`;
    } else if (activeSite === 'recommend') {
      url = `/api/recommend?site=bilibili&page=${page}`; // 推荐默认拉B站
    } else if (activeSite === 'favorites') {
      url = `/api/favorites`;
    } else {
      // 平台房间
      if (activeSubCategory) {
        url = `/api/rooms?site=${activeSite}&categoryId=${activeSubCategory.id}&parentId=${activeSubCategory.parentId}&name=${encodeURIComponent(activeSubCategory.name)}&page=${page}`;
      } else {
        url = `/api/recommend?site=${activeSite}&page=${page}`;
      }
    }

    const data = await fetchApi(url, { method, body });
    spinner.style.display = 'none';

    if (data.success) {
      let items = [];
      if (activeSite === 'favorites') {
        items = data.favorites || [];
        hasMore = false;
      } else {
        items = data.items || [];
        hasMore = data.hasMore || false;
      }

      if (reset && items.length === 0) {
        noData.style.display = 'block';
      } else {
        renderRoomCards(items);
        if (hasMore) {
          loadMore.style.display = 'flex';
        } else {
          loadMore.style.display = 'none';
        }
      }
    } else {
      noData.innerText = data.message || '获取数据失败';
      noData.style.display = 'block';
    }
  } catch (err) {
    spinner.style.display = 'none';
    noData.innerText = '加载数据出错，请检查网络';
    noData.style.display = 'block';
    console.error(err);
  } finally {
    isLoading = false;
  }
}

// 渲染房间卡片
function renderRoomCards(rooms) {
  const grid = document.getElementById('rooms-grid');
  
  rooms.forEach(room => {
    // 如果是收藏列表，有些房间会有具体的 site 标志，我们需要判断
    const site = room.site || activeSite;

    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-cover-wrapper">
        <img class="room-cover" src="${room.cover || '/assets/logo.png'}" alt="cover" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%25%22 height=%22100%25%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%231b2336%22/><text x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%238b9bb4%22 font-family=%22sans-serif%22 font-size=%2214%22>主播休息中</text></svg>'">
        <span class="room-status-badge ${room.liveStatus || room.status ? 'live' : 'offline'}">
          ${room.liveStatus || room.status ? '直播中' : '未开播'}
        </span>
        <span class="room-online-count">${formatOnline(room.online)}</span>
      </div>
      <div class="room-info">
        <h4 class="room-title" title="${escapeHtml(room.title)}">${escapeHtml(room.title)}</h4>
        <div class="room-anchor">
          <img class="room-avatar" src="${room.userAvatar || 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22><rect width=%2224%22 height=%2224%22 fill=%22%231b2336%22/></svg>'}" alt="avatar" onerror="this.style.opacity=0">
          <span class="room-anchor-name">${escapeHtml(room.userName)}</span>
          <span class="room-platform-tag ${site}">${getPlatformName(site)}</span>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      openPlayer(site, room.roomId);
    });

    grid.appendChild(card);
  });
}

// 加载二级分类
async function loadCategories() {
  const categoryBar = document.getElementById('category-bar');
  const subCategoryBar = document.getElementById('sub-category-bar');

  categoryBar.innerHTML = '';
  subCategoryBar.innerHTML = '';
  subCategoryBar.style.display = 'none';

  try {
    const data = await fetchApi(`/api/categories?site=${activeSite}`);
    if (data.success && data.categories.length > 0) {
      const categories = data.categories;
      
      // 默认推荐按钮
      const recBtn = document.createElement('button');
      recBtn.className = 'category-btn active';
      recBtn.innerText = '全部推荐';
      recBtn.addEventListener('click', () => {
        document.querySelectorAll('#category-bar .category-btn').forEach(b => b.classList.remove('active'));
        recBtn.classList.add('active');
        activeCategory = null;
        activeSubCategory = null;
        subCategoryBar.style.display = 'none';
        loadRooms(true);
      });
      categoryBar.appendChild(recBtn);

      categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'category-btn';
        btn.innerText = cat.name;
        btn.addEventListener('click', () => {
          document.querySelectorAll('#category-bar .category-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeCategory = cat;
          
          // 渲染子分类
          renderSubCategories(cat.children);
        });
        categoryBar.appendChild(btn);
      });
    }
  } catch (e) {
    console.error('Failed to load categories', e);
  }
}

function renderSubCategories(children) {
  const subCategoryBar = document.getElementById('sub-category-bar');
  subCategoryBar.innerHTML = '';

  if (!children || children.length === 0) {
    subCategoryBar.style.display = 'none';
    activeSubCategory = null;
    loadRooms(true);
    return;
  }

  subCategoryBar.style.display = 'flex';

  children.forEach(sub => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.innerText = sub.name;
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sub-category-bar .category-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSubCategory = sub;
      loadRooms(true);
    });
    subCategoryBar.appendChild(btn);
  });

  // 默认触发第一个子分类
  subCategoryBar.querySelector('.category-btn').click();
}

// ================= 播放器与实时弹幕 =================

async function openPlayer(site, roomId) {
  const modal = document.getElementById('player-modal');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden'; // 禁止底页滚动

  currentRoom = { site, roomId };
  
  // 初始化弹窗头部骨架
  document.getElementById('player-title').innerText = '正在载入直播间信息...';
  document.getElementById('player-anchor').innerText = '';
  document.getElementById('player-site').innerText = getPlatformName(site);
  document.getElementById('player-online').innerText = '0';
  document.getElementById('player-avatar').src = '';
  document.getElementById('quality-buttons').innerHTML = '';
  document.getElementById('danmaku-list').innerHTML = `<div class="danmaku-item danmaku-system">正在连接弹幕服务器...</div>`;

  // 判断是否已关注
  updateFavButtonState();

  try {
    // 获取房间详情和清晰度
    const data = await fetchApi(`/api/room/detail?site=${site}&roomId=${roomId}`);
    if (data.success) {
      const detail = data.detail;
      qualities = data.qualities || [];

      document.getElementById('player-title').innerText = detail.title;
      document.getElementById('player-anchor').innerText = detail.userName;
      document.getElementById('player-online').innerText = formatOnline(detail.online);
      if (detail.userAvatar) {
        document.getElementById('player-avatar').src = detail.userAvatar;
      }

      // 如果未开播
      if (!detail.status) {
        document.getElementById('danmaku-list').innerHTML += `<div class="danmaku-item danmaku-system">主播目前处于开播休息状态。</div>`;
        initDPlayerOffline();
        return;
      }

      // 渲染画质切换按钮
      renderQualityButtons(qualities);

      // 默认播放第一个画质
      if (qualities.length > 0) {
        playRoomWithQuality(qualities[0]);
      } else {
        document.getElementById('danmaku-list').innerHTML += `<div class="danmaku-item danmaku-system">无法获取该房间清晰度列表</div>`;
      }

      // 连接弹幕 WebSocket
      connectDanmakuWS(site, roomId);

    } else {
      document.getElementById('player-title').innerText = '获取直播间详情失败';
      document.getElementById('danmaku-list').innerHTML = `<div class="danmaku-item danmaku-system">错误：${data.message}</div>`;
    }
  } catch (err) {
    document.getElementById('player-title').innerText = '加载直播失败';
    console.error(err);
  }
}

function initDPlayerOffline() {
  if (dp) dp.destroy();
  
  dp = new DPlayer({
    container: document.getElementById('dplayer'),
    live: false,
    video: {
      url: '', // 空地址
    }
  });
  
  // 绘制提示层
  const notice = document.createElement('div');
  notice.style.position = 'absolute';
  notice.style.top = '50%';
  notice.style.left = '50%';
  notice.style.transform = 'translate(-50%, -50%)';
  notice.style.color = '#fff';
  notice.style.fontSize = '16px';
  notice.style.fontWeight = '600';
  notice.innerText = '主播已下播，稍后再来吧';
  document.getElementById('dplayer').appendChild(notice);
}

// 请求具体画质直链并播放
async function playRoomWithQuality(quality) {
  const listDiv = document.getElementById('danmaku-list');
  listDiv.innerHTML += `<div class="danmaku-item danmaku-system">正在拉取 [${quality.quality}] 播放流...</div>`;

  try {
    const data = await fetchApi(`/api/room/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site: currentRoom.site,
        roomId: currentRoom.roomId,
        quality: quality.quality,
        index: quality.index
      })
    });

    if (data.success && data.urls.length > 0) {
      const playUrl = data.urls[0]; // 选取第一条可用线路
      listDiv.innerHTML += `<div class="danmaku-item danmaku-system">播放流载入成功，开始解码播放。</div>`;
      initDPlayer(playUrl);
    } else {
      listDiv.innerHTML += `<div class="danmaku-item danmaku-system">错误：获取流直链失败。</div>`;
    }
  } catch (err) {
    listDiv.innerHTML += `<div class="danmaku-item danmaku-system">拉取流出错：${err.message}</div>`;
    console.error(err);
  }
}

function initDPlayer(videoUrl) {
  if (dp) dp.destroy();

  // 判断视频流类型
  let videoType = 'normal';
  if (videoUrl.includes('.m3u8') || videoUrl.includes('m3u8')) {
    videoType = 'hls';
  } else if (videoUrl.includes('.flv') || videoUrl.includes('flv')) {
    videoType = 'flv';
  }

  // 针对 iOS Safari 的优化：iOS 原生支持 m3u8，如果 hls 解码器失效，可以用原生 video 兼容
  dp = new DPlayer({
    container: document.getElementById('dplayer'),
    live: true,
    autoplay: true,
    preventClickToggle: true, // 禁用点击画面暂停以避免直播流断连恢复失败
    video: {
      url: videoUrl,
      type: videoType,
      customType: {
        hls: function (video, player) {
          if (Hls.isSupported()) {
            const hls = new Hls({
              maxBufferLength: 20,             // 适度缓冲区大小（20秒）
              maxMaxBufferLength: 40,          // 极限缓冲区大小（40秒）
              backBufferLength: 10,            // 关键：强制释放已播完的 10 秒前历史切片，防止内存无限累积卡死
              liveSyncDurationCount: 4,        // 保持 4 个切片的安全同步（多蓄水）
              liveMaxLatencyDurationCount: 8,
              enableWorker: true,              // 启用 worker 线程
              lowLatencyMode: false            // 以画面平滑蓄水优先
            });
            hls.loadSource(video.src);
            hls.attachMedia(video);

            // ======== 虎牙流 Token 自动续期机制 ========
            // 虎牙流地址签名 wsTime 有效期约 5-15 分钟，过期后 CDN 返回 403 导致画面卡死
            // 解决方案：双保险
            //   1. 主动定时器（每 4 分钟预刷）
            //   2. 被动错误监听（fatal NETWORK_ERROR 时立即刷新）
            if (currentRoom && currentRoom.site === 'huya') {
              let isRefreshing = false;

              const refreshHuyaStream = async () => {
                if (isRefreshing) return;
                isRefreshing = true;
                try {
                  const activeQualityBtn = document.querySelector('#quality-buttons .btn-quality.active');
                  const currentQuality = qualities.find(q => q.quality === (activeQualityBtn?.innerText || '')) || qualities[0];
                  if (!currentQuality) return;

                  const data = await fetchApi('/api/room/urls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      site: currentRoom.site,
                      roomId: currentRoom.roomId,
                      quality: currentQuality.quality,
                      index: currentQuality.index
                    })
                  });

                  if (data.success && data.urls && data.urls.length > 0) {
                    const newUrl = data.urls[0];
                    console.log('[Huya] 流地址已自动续期刷新:', newUrl);
                    hls.stopLoad();
                    hls.loadSource(newUrl);
                    hls.startLoad();
                  }
                } catch (e) {
                  console.error('[Huya] 流地址续期刷新失败', e);
                } finally {
                  isRefreshing = false;
                }
              };

              // 1. 主动定时续期：每 4 分钟预刷（比 wsTime 过期留足余量）
              if (huyaRefreshTimer) clearInterval(huyaRefreshTimer);
              huyaRefreshTimer = setInterval(refreshHuyaStream, 4 * 60 * 1000);

              // 2. 被动错误监听：fatal NETWORK_ERROR（含403）立即触发续期
              hls.on(Hls.Events.ERROR, (event, errData) => {
                if (errData.fatal) {
                  if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    console.warn('[Huya] HLS fatal 网络错误，触发自动续期...');
                    refreshHuyaStream();
                  } else if (errData.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    console.warn('[Huya] HLS 媒体错误，尝试自愈...');
                    hls.recoverMediaError();
                  }
                }
              });
            }
            // ======== END 虎牙流 Token 自动续期机制 ========

          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // iOS/Safari 的原生播放兼容，必须正确载入真实流地址并主动加载
            video.src = videoUrl;
            video.load();
          }
        },
        flv: function (video, player) {
          if (flvjs.isSupported()) {
            const flvPlayer = flvjs.createPlayer({
              type: 'flv',
              url: video.src,
              isLive: true
            }, {
              enableWorker: true,
              enableStashBuffer: true,
              stashInitialSize: 512 * 1024,   // 512KB 预存缓存，大幅抗抖动
              seekType: 'range',
              lazyLoad: false                 // 积极预载
            });
            flvPlayer.attachMediaElement(video);
            flvPlayer.load();
          }
        }
      }
    },
    danmaku: {
      id: currentRoom.roomId,
      api: '/api/dplayer/', // 指向本地空弹幕响应，规避超时与卡顿
      bottom: '15%',
      unlimited: true
    }
  });

  dp.on('error', () => {
    console.error('DPlayer media error, trying reload...');
    // 如果播放出错，可提供重试或切换线路提示
  });
}

function renderQualityButtons(qs) {
  const container = document.getElementById('quality-buttons');
  container.innerHTML = '';

  qs.forEach((q, idx) => {
    const btn = document.createElement('button');
    btn.className = `btn-quality ${idx === 0 ? 'active' : ''}`;
    btn.innerText = q.quality;
    btn.addEventListener('click', () => {
      document.querySelectorAll('#quality-buttons .btn-quality').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      playRoomWithQuality(q);
    });
    container.appendChild(btn);
  });
}

// 建立弹幕 WebSocket 连接
function connectDanmakuWS(site, roomId) {
  if (ws) {
    ws.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/danmaku?site=${site}&roomId=${roomId}&token=${token}`;

  ws = new WebSocket(wsUrl);
  
  const listDiv = document.getElementById('danmaku-list');

  ws.onopen = () => {
    listDiv.innerHTML += `<div class="danmaku-item danmaku-system">成功连接实时弹幕服务器。</div>`;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'chat') {
        // 校验屏蔽关键词与通配符，满足条件直接拦截丢弃
        if (isBlocked(data.message)) {
          return;
        }
        // 渲染到 DPlayer 弹幕层 (添加 250ms 时间戳防刷限制，防止超高频弹幕重绘卡死主线程)
        const now = Date.now();
        if (dp && dp.danmaku && (now - lastDrawTime > 250)) {
          dp.danmaku.draw({
            text: data.message,
            color: '#ffffff',
            type: 'right'
          });
          lastDrawTime = now;
        }

        // 加入批量节流渲染队列
        pendingDanmakus.push(data);
        if (!danmakuTimer) {
          danmakuTimer = setTimeout(flushDanmakus, 150);
        }
      } else if (data.type === 'online') {
        document.getElementById('player-online').innerText = formatOnline(data.online);
      } else if (data.type === 'error') {
        listDiv.innerHTML += `<div class="danmaku-item danmaku-system" style="color: #ff5252">${data.message}</div>`;
      }
    } catch (e) {
      console.error('Error parsing WS message', e);
    }
  };

  ws.onclose = (e) => {
    listDiv.innerHTML += `<div class="danmaku-item danmaku-system">弹幕服务器连接断开。</div>`;
  };

  ws.onerror = (err) => {
    console.error('WebSocket error', err);
  };
}

function closePlayer() {
  document.getElementById('player-modal').style.display = 'none';
  document.body.style.overflow = ''; // 恢复滚动

  // 清理虎牙流地址续期定时器
  if (huyaRefreshTimer) {
    clearInterval(huyaRefreshTimer);
    huyaRefreshTimer = null;
  }

  if (dp) {
    dp.destroy();
    dp = null;
  }

  if (ws) {
    ws.close();
    ws = null;
  }

  currentRoom = null;
}

// ================= 关注业务处理 =================

function isCurrentRoomFavorited() {
  if (!currentRoom) return false;
  return favorites.some(fav => fav.site === currentRoom.site && fav.roomId === currentRoom.roomId);
}

function updateFavButtonState() {
  const btn = document.getElementById('player-fav-btn');
  if (isCurrentRoomFavorited()) {
    btn.classList.add('active');
    btn.innerHTML = '⭐ 已关注';
  } else {
    btn.classList.remove('active');
    btn.innerHTML = '☆ 关注主播';
  }
}

async function toggleFavorite() {
  if (!currentRoom) return;

  const faved = isCurrentRoomFavorited();
  const method = faved ? 'DELETE' : 'POST';

  try {
    let body = {
      site: currentRoom.site,
      roomId: currentRoom.roomId
    };

    if (!faved) {
      // 关注时需要把当前主播名、封面、头像、标题等数据一同发送持久化
      const title = document.getElementById('player-title').innerText;
      const userName = document.getElementById('player-anchor').innerText;
      const avatar = document.getElementById('player-avatar').src;
      // 查找该房间的卡片以获取封面图，若无则传空
      const cards = document.querySelectorAll('.room-card');
      let cover = '';
      for (let c of cards) {
        // 这里只是简单比对，直接取大厅里的图
        if (c.innerHTML.includes(currentRoom.roomId)) {
          const img = c.querySelector('.room-cover');
          if (img) cover = img.src;
          break;
        }
      }
      body.title = title;
      body.userName = userName;
      body.cover = cover;
      body.userAvatar = avatar;
    }

    const data = await fetchApi('/api/favorites', {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (data.success) {
      await loadFavoritesCount();
      updateFavButtonState();
      
      // 如果当前正在“我的关注”列表页，则立即刷新大厅以移除/添加卡片
      if (activeSite === 'favorites') {
        loadRooms(true);
      }
    }
  } catch (e) {
    console.error('Failed to toggle favorite', e);
  }
}

// ================= 辅助函数 =================

function getPlatformName(site) {
  const names = {
    'bilibili': 'B站',
    'huya': '虎牙',
    'douyu': '斗鱼',
    'douyin': '抖音',
    'recommend': '推荐'
  };
  return names[site] || site;
}

function formatOnline(num) {
  const n = parseInt(num) || 0;
  if (n >= 10000) {
    return (n / 10000).toFixed(1) + '万';
  }
  return n.toString();
}

function escapeHtml(string) {
  const matchHtmlRegExp = /["'&<>]/;
  const str = '' + string;
  const match = matchHtmlRegExp.exec(str);

  if (!match) {
    return str;
  }

  let escape;
  let html = '';
  let index = 0;
  let lastIndex = 0;

  for (index = match.index; index < str.length; index++) {
    switch (str.charCodeAt(index)) {
      case 34: // "
        escape = '&quot;';
        break;
      case 38: // &
        escape = '&amp;';
        break;
      case 39: // '
        escape = '&#39;';
        break;
      case 60: // <
        escape = '&lt;';
        break;
      case 62: // >
        escape = '&gt;';
        break;
      default:
        continue;
    }

    if (lastIndex !== index) {
      html += str.substring(lastIndex, index);
    }

    lastIndex = index + 1;
    html += escape;
  }

  return lastIndex !== index
    ? html + str.substring(lastIndex, index)
    : html;
}

function updateMobileTitle() {
  const title = getPlatformName(activeSite);
  document.getElementById('mobile-title').innerText = activeSite === 'search' ? '搜索结果' : title;
}

// 移动端侧边栏交互遮罩
function createOverlay() {
  if (document.querySelector('.sidebar-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.addEventListener('click', () => {
    document.querySelector('.app-sidebar').classList.remove('open');
    removeOverlay();
  });
  document.body.appendChild(overlay);
}

function removeOverlay() {
  const overlay = document.querySelector('.sidebar-overlay');
  if (overlay) overlay.remove();
}

function closeMobileSidebar() {
  document.querySelector('.app-sidebar').classList.remove('open');
  removeOverlay();
}

// ================= B站扫码登录模块 =================

function closeBiliQRModal() {
  document.getElementById('bili-qr-modal').style.display = 'none';
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}

async function startBiliQRLogin() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }

  const mask = document.getElementById('bili-qr-status-mask');
  const img = document.getElementById('bili-qr-img');
  const tips = document.getElementById('bili-qr-tips');

  mask.style.display = 'flex';
  mask.innerText = '正在生成二维码...';
  img.style.display = 'none';
  tips.innerText = '请使用手机哔哩哔哩客户端扫码登录';

  try {
    const data = await fetchApi('/api/bilibili/qr/generate');
    if (data.code === 0 && data.data) {
      qrKey = data.data.qrcode_key;
      qrB3 = data.buvid3 || '';
      qrB4 = data.buvid4 || '';
      const url = data.data.url;

      // 渲染二维码
      img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
      img.onload = () => {
        mask.style.display = 'none';
        img.style.display = 'block';
      };

      // 启动轮询
      qrPollTimer = setInterval(pollBiliQRStatus, 3000);
    } else {
      mask.innerText = '生成二维码失败，请重试';
    }
  } catch (err) {
    mask.innerText = '连接服务器失败';
    console.error(err);
  }
}

async function pollBiliQRStatus() {
  if (!qrKey) return;
  
  const mask = document.getElementById('bili-qr-status-mask');
  const img = document.getElementById('bili-qr-img');
  const tips = document.getElementById('bili-qr-tips');

  try {
    const data = await fetchApi(`/api/bilibili/qr/poll?key=${qrKey}&b3=${encodeURIComponent(qrB3)}&b4=${encodeURIComponent(qrB4)}`);
    if (data.code === 0 && data.data) {
      const code = data.data.code;
      if (code === 0) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
        mask.style.display = 'flex';
        mask.innerText = '🎉 登录成功！';
        tips.innerText = '配置已更新，画质与弹幕已解锁';
        
        setTimeout(() => {
          closeBiliQRModal();
          updateBiliStatus();
          loadRooms(true);
        }, 1500);
      } else if (code === 86038) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
        mask.style.display = 'flex';
        mask.innerText = '❌ 二维码已失效';
        tips.innerText = '请点击刷新按钮重新获取二维码';
      } else if (code === 86090) {
        mask.style.display = 'flex';
        mask.innerText = '📱 已扫码，请在手机上确认';
      }
    }
  } catch (err) {
    console.error('Polling QR status error', err);
  }
}

async function handleSaveBiliCookie() {
  const cookieVal = document.getElementById('bili-cookie-input').value;
  if (!cookieVal.trim()) {
    alert('请输入有效的 B站 Cookie！');
    return;
  }

  const btn = document.getElementById('bili-save-cookie-btn');
  btn.disabled = true;
  btn.innerText = '保存中...';

  try {
    const res = await fetchApi('/api/bilibili/cookie', {
      method: 'POST',
      body: JSON.stringify({ cookie: cookieVal })
    });

    if (res.success) {
      alert('🎉 Cookie 保存并应用成功！');
      closeBiliQRModal();
      updateBiliStatus();
      loadRooms(true);
    } else {
      alert('保存失败：' + res.message);
    }
  } catch (err) {
    alert('连接服务器失败');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.innerText = '保存并生效';
  }
}

function flushDanmakus() {
  danmakuTimer = null;
  if (pendingDanmakus.length === 0) return;

  const listDiv = document.getElementById('danmaku-list');
  if (!listDiv) {
    pendingDanmakus = [];
    return;
  }

  // 使用 DocumentFragment 一次性批量挂载，仅触发一次重排
  const fragment = document.createDocumentFragment();
  pendingDanmakus.forEach(data => {
    const msgItem = document.createElement('div');
    msgItem.className = 'danmaku-item';
    msgItem.innerHTML = `<span class="danmaku-author">${escapeHtml(data.userName)}:</span><span class="danmaku-text">${escapeHtml(data.message)}</span>`;
    fragment.appendChild(msgItem);
  });

  listDiv.appendChild(fragment);
  pendingDanmakus = [];

  // 严格控制列表最大节点数，防内存泄露
  while (listDiv.children.length > 200) {
    listDiv.removeChild(listDiv.firstChild);
  }

  // 触发单次重排到底部
  listDiv.scrollTop = listDiv.scrollHeight;
}

async function handleBiliAction() {
  const btn = document.getElementById('bili-login-btn');
  if (btn && btn.getAttribute('data-action') === 'logout') {
    if (confirm('确定要注销当前的 Bilibili 登录凭证吗？注销后将无法获取高清画质。')) {
      try {
        const res = await fetchApi('/api/bilibili/logout', { method: 'POST' });
        if (res.success) {
          alert('B站登录凭证已注销！');
          updateBiliStatus();
          loadRooms(true);
        }
      } catch (err) {
        alert('连接服务器失败');
        console.error(err);
      }
    }
  } else {
    document.getElementById('bili-qr-modal').style.display = 'flex';
    document.getElementById('bili-manual-input-area').style.display = 'none';
    document.getElementById('bili-cookie-input').value = '';
    document.getElementById('bili-toggle-manual-btn').innerText = '手动输入 Cookie (备用)';
    startBiliQRLogin();
  }
}

async function updateBiliStatus() {
  const statusText = document.getElementById('bili-status-text');
  const loginBtn = document.getElementById('bili-login-btn');

  if (!statusText || !loginBtn) return;

  try {
    const data = await fetchApi('/api/bilibili/status');
    if (data.success && data.isLogin) {
      statusText.innerHTML = `<span id="bili-status-dot" style="width: 6px; height: 6px; border-radius: 50%; background: #4caf50; display: inline-block; transition: all 0.3s;"></span> B站已登录: ${escapeHtml(data.uname)}`;
      loginBtn.innerText = '注销';
      loginBtn.style.background = 'rgba(255, 82, 82, 0.1)';
      loginBtn.style.color = '#ff5252';
      loginBtn.style.border = '1px solid rgba(255, 82, 82, 0.3)';
      loginBtn.style.padding = '3px 6px';
      loginBtn.setAttribute('data-action', 'logout');
    } else {
      statusText.innerHTML = `<span id="bili-status-dot" style="width: 6px; height: 6px; border-radius: 50%; background: #ff9800; display: inline-block; transition: all 0.3s;"></span> B站未登录`;
      loginBtn.innerText = '扫码登录';
      loginBtn.style.background = 'var(--accent-blue)';
      loginBtn.style.color = '#fff';
      loginBtn.style.border = 'none';
      loginBtn.style.padding = '3px 6px';
      loginBtn.setAttribute('data-action', 'login');
    }
  } catch (err) {
    console.error('Failed to check Bilibili status', err);
    statusText.innerHTML = `<span id="bili-status-dot" style="width: 6px; height: 6px; border-radius: 50%; background: #ff5252; display: inline-block; transition: all 0.3s;"></span> 连接失败`;
  }
}

// ================= 弹幕屏蔽规则与网址直达核心模块 =================

function parseLiveUrl(url) {
  url = url.trim();
  // B站 (支持 https://live.bilibili.com/22637287 及其 h5 页面)
  let match = url.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/i);
  if (match) {
    return { site: 'bilibili', roomId: match[1] };
  }

  // 虎牙 (支持 https://www.huya.com/998 及其 m 移动页面)
  match = url.match(/huya\.com\/([a-zA-Z0-9_-]+)/i);
  if (match) {
    return { site: 'huya', roomId: match[1] };
  }

  // 斗鱼 (支持 https://www.douyu.com/100 及其移动端专题)
  match = url.match(/douyu\.com\/(?:topic\/[a-zA-Z0-9_#-]+\?rid=)?(\d+)/i);
  if (!match) {
    match = url.match(/douyu\.com\/(\d+)/i);
  }
  if (match) {
    return { site: 'douyu', roomId: match[1] };
  }

  return null;
}

function loadBlockRules() {
  try {
    const data = localStorage.getItem('danmaku_block_rules');
    if (data) {
      blockRules = JSON.parse(data);
    } else {
      blockRules = [];
    }
  } catch (e) {
    console.error('Failed to load block rules', e);
    blockRules = [];
  }
}

function openBlockModal() {
  document.getElementById('block-settings-modal').style.display = 'flex';
  document.getElementById('block-rules-input').value = blockRules.join('\n');
}

function closeBlockModal() {
  document.getElementById('block-settings-modal').style.display = 'none';
}

function saveBlockRules() {
  const text = document.getElementById('block-rules-input').value;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  try {
    localStorage.setItem('danmaku_block_rules', JSON.stringify(lines));
    blockRules = lines;
    alert('🎉 弹幕屏蔽规则保存并生效成功！');
    closeBlockModal();
  } catch (e) {
    alert('保存失败，浏览器本地空间不足');
    console.error(e);
  }
}

function isBlocked(message) {
  if (!message || blockRules.length === 0) return false;

  for (let rule of blockRules) {
    if (!rule) continue;

    try {
      // 1. 将屏蔽词中的正则特殊元字符进行安全转义，保留 * 号
      let regStr = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      // 2. 将通配符 * 转换为匹配任意字符的 .* 
      regStr = regStr.replace(/\*/g, '.*');
      // 3. 构建正则表达式（不区分大小写，全局包含）
      const regex = new RegExp(regStr, 'i');
      if (regex.test(message)) {
        return true;
      }
    } catch (err) {
      console.error('Invalid wildcard pattern matching: ' + rule, err);
    }
  }
  return false;
}
