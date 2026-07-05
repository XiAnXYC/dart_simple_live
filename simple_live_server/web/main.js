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

  // 导航栏事件
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const action = item.getAttribute('data-action');
      const val = item.getAttribute('data-value');

      // 重置分类和搜索
      activeCategory = null;
      activeSubCategory = null;
      searchKeyword = '';
      document.getElementById('search-input').value = '';

      if (action === 'site') {
        activeSite = val;
        loadRooms(true);
      } else if (action === 'favorites') {
        activeSite = 'favorites';
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
      searchKeyword = val;
      activeSite = 'search'; // 搜索状态
      // 默认搜索哔哩哔哩平台，可在搜索结果页自由切换平台
      activeCategory = null;
      activeSubCategory = null;
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
    // 隐藏/显示分类栏
    if (activeSite !== 'recommend' && activeSite !== 'favorites' && activeSite !== 'search') {
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

    if (activeSite === 'recommend') {
      url = `/api/recommend?site=bilibili&page=${page}`; // 推荐默认拉B站
    } else if (activeSite === 'favorites') {
      url = `/api/favorites`;
    } else if (activeSite === 'search') {
      // 搜索默认为跨平台（可对已选定的站发起搜索）
      // 这里默认在B站搜索，如果在侧边栏选择过别的平台，就对该平台搜索
      const site = ['bilibili', 'huya', 'douyu', 'douyin'].includes(activeSite) ? activeSite : 'bilibili';
      url = `/api/search?site=${site}&keyword=${encodeURIComponent(searchKeyword)}&page=${page}`;
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
        data: quality.data
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
    video: {
      url: videoUrl,
      type: videoType
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
        // 渲染到 DPlayer 弹幕层
        if (dp && dp.danmaku) {
          dp.danmaku.draw({
            text: data.message,
            color: '#ffffff',
            type: 'right'
          });
        }

        // 追加到弹幕列表侧边栏
        const msgItem = document.createElement('div');
        msgItem.className = 'danmaku-item';
        msgItem.innerHTML = `<span class="danmaku-author">${escapeHtml(data.userName)}:</span><span class="danmaku-text">${escapeHtml(data.message)}</span>`;
        listDiv.appendChild(msgItem);

        // 滚动到底部
        listDiv.scrollTop = listDiv.scrollHeight;

        // 控制列表大小，防止海量弹幕卡死浏览器 (保留最新200条)
        if (listDiv.children.length > 200) {
          listDiv.removeChild(listDiv.firstChild);
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
