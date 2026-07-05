import 'dart:convert';
import 'dart:io';

import 'package:simple_live_core/simple_live_core.dart';
import 'package:dio/dio.dart';

Map<String, dynamic> config = {};
String configPath = '';
// 缓存各直播间解析出的原装画质对象，以供在获取播放地址时正确还原其底层自定义对象（如 HuyaLineModel）
final Map<String, List<LivePlayQuality>> _qualitiesCache = {};
final Dio _dio = Dio();

void main() async {
  // 查找配置文件和静态资源目录
  var scriptPath = Platform.script.toFilePath();
  var serverDir = File(scriptPath).parent.parent.path;
  configPath = '$serverDir/config.json';
  var webPath = '$serverDir/web';

  // 读取配置
  await loadConfig();

  int port = config['port'] ?? 8080;
  var server = await HttpServer.bind(InternetAddress.anyIPv4, port);
  print('Simple Live Web Server is running on port $port');
  print('Static web directory: $webPath');

  await for (HttpRequest request in server) {
    handleRequest(request, webPath);
  }
}

Future<void> loadConfig() async {
  try {
    var file = File(configPath);
    if (await file.exists()) {
      config = json.decode(await file.readAsString());
    } else {
      config = {
        "port": 8080,
        "users": [
          {
            "username": "admin",
            "password": "admin888",
            "favorites": []
          }
        ]
      };
    }
  } catch (e) {
    print('Error loading config: $e');
  }
}

Future<void> saveConfig() async {
  try {
    var file = File(configPath);
    var encoder = JsonEncoder.withIndent('  ');
    await file.writeAsString(encoder.convert(config));
  } catch (e) {
    print('Error saving config: $e');
  }
}

LiveSite? getSite(String siteName) {
  switch (siteName.toLowerCase()) {
    case 'bilibili':
      var site = BiliBiliSite();
      var bCookie = config['bilibili_cookie'] as String?;
      if (bCookie != null && bCookie.isNotEmpty) {
        site.cookie = bCookie;
      }
      return site;
    case 'huya':
      return HuyaSite();
    case 'douyu':
      return DouyuSite();
    case 'douyin':
      var site = DouyinSite();
      var dyCookie = config['douyin_cookie'] as String?;
      if (dyCookie != null && dyCookie.isNotEmpty) {
        site.cookie = dyCookie;
      }
      return site;
    default:
      return null;
  }
}

String? authenticate(String username, String password) {
  var users = config['users'] as List?;
  if (users == null) return null;
  for (var u in users) {
    if (u['username'] == username && u['password'] == password) {
      var bytes = utf8.encode(username);
      var base64Str = base64.encode(bytes);
      return 'token_$base64Str';
    }
  }
  return null;
}

String? getUsernameFromToken(String token) {
  if (!token.startsWith('token_')) return null;
  try {
    var base64Str = token.substring(6);
    var bytes = base64.decode(base64Str);
    return utf8.decode(bytes);
  } catch (e) {
    return null;
  }
}

String? validateTokenAndGetUsername(HttpRequest request) {
  var authHeader = request.headers.value('Authorization');
  if (authHeader == null || !authHeader.startsWith('Bearer ')) {
    var tokenParam = request.uri.queryParameters['token'];
    if (tokenParam != null) {
      return getUsernameFromToken(tokenParam);
    }
    return null;
  }
  var token = authHeader.substring(7);
  return getUsernameFromToken(token);
}

Future<Map<String, dynamic>?> readJsonBody(HttpRequest request) async {
  try {
    var content = await utf8.decoder.bind(request).join();
    return json.decode(content) as Map<String, dynamic>;
  } catch (e) {
    return null;
  }
}

void sendJsonResponse(HttpRequest request, dynamic data, {int status = HttpStatus.ok}) async {
  request.response.statusCode = status;
  request.response.headers.contentType = ContentType.json;
  request.response.write(json.encode(data));
  await request.response.close();
}

void handleRequest(HttpRequest request, String webPath) async {
  // CORS 支持
  request.response.headers.add('Access-Control-Allow-Origin', '*');
  request.response.headers.add('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  request.response.headers.add('Access-Control-Allow-Headers', 'Origin, Content-Type, Authorization');

  if (request.method == 'OPTIONS') {
    request.response.statusCode = HttpStatus.ok;
    await request.response.close();
    return;
  }

  var path = request.uri.path;

  // WebSocket 弹幕中转
  if (path == '/danmaku') {
    handleWebSocketDanmaku(request);
    return;
  }

  // 流代理：后端以 Huya/Douyu 官方 Referer 拉取直播流后转发给浏览器，绕开 CDN 的 CORS 策略
  // 路径格式：/stream/proxy?url=<encoded-url>&token=<auth-token>
  if (path == '/stream/proxy') {
    final params = request.uri.queryParameters;
    final streamUrl = params['url'];
    final tkn = params['token'];

    // 简单鉴权：验证 token 参数
    if (streamUrl == null || streamUrl.isEmpty || tkn == null || getUsernameFromToken(tkn) == null) {
      request.response.statusCode = HttpStatus.forbidden;
      await request.response.close();
      return;
    }

    // 安全校验：只允许代理直播 CDN 域名，防止 SSRF
    final allowedHosts = ['huya.com', 'douyu.com', 'bilibili.com', 'bilivideo.com',
                          'douyucdn.cn', 'douyucdn2.cn'];
    final parsedUri = Uri.tryParse(streamUrl);
    if (parsedUri == null || !allowedHosts.any((h) => parsedUri.host.endsWith(h))) {
      request.response.statusCode = HttpStatus.forbidden;
      await request.response.close();
      return;
    }

    try {
      final client = HttpClient();
      // 使用与 Huya 官方网页端相同的请求头，确保 CDN 接受请求
      final proxyReq = await client.getUrl(parsedUri);
      proxyReq.headers.set(HttpHeaders.refererHeader, 'https://www.huya.com/');
      proxyReq.headers.set(HttpHeaders.userAgentHeader,
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      proxyReq.headers.set('Origin', 'https://www.huya.com');

      final proxyResp = await proxyReq.close();

      // 将 CDN 响应头透传给浏览器（保留 Content-Type，注入 CORS 头）
      request.response.statusCode = proxyResp.statusCode;
      request.response.headers.add('Access-Control-Allow-Origin', '*');
      request.response.headers.add('Cache-Control', 'no-cache');

      // 检测内容类型：FLV 流
      final contentType = proxyResp.headers.contentType;
      if (contentType != null) {
        request.response.headers.contentType = contentType;
      } else {
        request.response.headers.contentType = ContentType('video', 'x-flv');
      }

      // 直接 pipe 流数据（不缓冲，低延迟转发）
      await proxyResp.pipe(request.response);
    } catch (e) {
      print('Stream proxy error: $e');
      try {
        request.response.statusCode = HttpStatus.badGateway;
        await request.response.close();
      } catch (_) {}
    }
    return;
  }

  // API 路由
  if (path.startsWith('/api/')) {
    handleApiRequest(request);
    return;
  }

  // 静态文件服务
  handleStaticFile(request, webPath);
}

void handleApiRequest(HttpRequest request) async {
  var path = request.uri.path;
  var method = request.method;

  // 1. 登录验证
  if (path == '/api/login' && method == 'POST') {
    var body = await readJsonBody(request);
    if (body == null) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid JSON body'}, status: HttpStatus.badRequest);
      return;
    }
    var username = body['username'] as String?;
    var password = body['password'] as String?;
    if (username == null || password == null) {
      sendJsonResponse(request, {'success': false, 'message': 'Username and password required'}, status: HttpStatus.badRequest);
      return;
    }
    var token = authenticate(username, password);
    if (token != null) {
      sendJsonResponse(request, {'success': true, 'token': token, 'username': username});
    } else {
      sendJsonResponse(request, {'success': false, 'message': '用户名或密码错误'});
    }
    return;
  }

  // DPlayer 弹幕 mock 接口（无需鉴权，DPlayer 内部自动调用，返回空弹幕即可）
  if (path.startsWith('/api/dplayer/')) {
    sendJsonResponse(request, {'code': 0, 'data': []});
    return;
  }

  // 校验登录态 (以下 API 全都需要登录)
  var username = validateTokenAndGetUsername(request);
  if (username == null) {
    sendJsonResponse(request, {'success': false, 'message': 'Unauthorized'}, status: HttpStatus.unauthorized);
    return;
  }

  // 2. 站点列表
  if (path == '/api/sites' && method == 'GET') {
    var sites = [
      {'id': 'bilibili', 'name': '哔哩哔哩'},
      {'id': 'huya', 'name': '虎牙直播'},
      {'id': 'douyu', 'name': '斗鱼直播'},
      {'id': 'douyin', 'name': '抖音直播'}
    ];
    sendJsonResponse(request, {'success': true, 'sites': sites});
    return;
  }

  // 3. 获取推荐直播
  if (path == '/api/recommend' && method == 'GET') {
    var params = request.uri.queryParameters;
    var siteName = params['site'] ?? '';
    var pageStr = params['page'] ?? '1';
    var page = int.tryParse(pageStr) ?? 1;

    var site = getSite(siteName);
    if (site == null) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid site'}, status: HttpStatus.badRequest);
      return;
    }

    try {
      var result = await site.getRecommendRooms(page: page);
      var items = result.items.map((e) => {
        'roomId': e.roomId,
        'title': e.title,
        'userName': e.userName,
        'cover': e.cover,
        'online': e.online,
        'userAvatar': '',
        'liveStatus': true,
      }).toList();
      sendJsonResponse(request, {'success': true, 'hasMore': result.hasMore, 'items': items});
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': 'Error: $e'}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 4. 获取平台分类列表
  if (path == '/api/categories' && method == 'GET') {
    var params = request.uri.queryParameters;
    var siteName = params['site'] ?? '';

    var site = getSite(siteName);
    if (site == null) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid site'}, status: HttpStatus.badRequest);
      return;
    }

    try {
      var result = await site.getCategores();
      var categories = result.map((c) => {
        'id': c.id,
        'name': c.name,
        'children': c.children.map((sub) => {
          'id': sub.id,
          'name': sub.name,
          'parentId': sub.parentId,
          'pic': sub.pic,
        }).toList()
      }).toList();
      sendJsonResponse(request, {'success': true, 'categories': categories});
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': 'Error: $e'}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 5. 获取分类下房间
  if (path == '/api/rooms' && method == 'GET') {
    var params = request.uri.queryParameters;
    var siteName = params['site'] ?? '';
    var categoryId = params['categoryId'] ?? '';
    var parentId = params['parentId'] ?? '';
    var categoryName = params['name'] ?? '';
    var pageStr = params['page'] ?? '1';
    var page = int.tryParse(pageStr) ?? 1;

    var site = getSite(siteName);
    if (site == null || categoryId.isEmpty) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid parameters'}, status: HttpStatus.badRequest);
      return;
    }

    try {
      var subCategory = LiveSubCategory(
        id: categoryId,
        name: categoryName,
        parentId: parentId,
      );
      var result = await site.getCategoryRooms(subCategory, page: page);
      var items = result.items.map((e) => {
        'roomId': e.roomId,
        'title': e.title,
        'userName': e.userName,
        'cover': e.cover,
        'online': e.online,
        'userAvatar': '',
        'liveStatus': true,
      }).toList();
      sendJsonResponse(request, {'success': true, 'hasMore': result.hasMore, 'items': items});
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': 'Error: $e'}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 6. 获取房间详情和清晰度列表
  if (path == '/api/room/detail' && method == 'GET') {
    var params = request.uri.queryParameters;
    var siteName = params['site'] ?? '';
    var roomId = params['roomId'] ?? '';

    var site = getSite(siteName);
    if (site == null || roomId.isEmpty) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid parameters'}, status: HttpStatus.badRequest);
      return;
    }

    try {
      var detail = await site.getRoomDetail(roomId: roomId);
      var qualities = <Map<String, dynamic>>[];
      if (detail.status) {
        var qList = await site.getPlayQualites(detail: detail);
        
        // 缓存强类型画质对象
        var cacheKey = '$siteName:$roomId';
        _qualitiesCache[cacheKey] = qList;

        // 构造发送给前端的画质，剔除 data 并追加 index
        for (var i = 0; i < qList.length; i++) {
          qualities.add({
            'quality': qList[i].quality,
            'sort': qList[i].sort,
            'index': i,
          });
        }
      }

      sendJsonResponse(request, {
        'success': true,
        'detail': {
          'roomId': detail.roomId,
          'title': detail.title,
          'userName': detail.userName,
          'cover': detail.cover,
          'online': detail.online,
          'userAvatar': detail.userAvatar,
          'status': detail.status, // 是否正在直播
          'danmakuData': null,
        },
        'qualities': qualities
      });
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': 'Error: $e'}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 7. 获取播放直链
  if (path == '/api/room/urls' && method == 'POST') {
    var body = await readJsonBody(request);
    if (body == null) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid JSON body'}, status: HttpStatus.badRequest);
      return;
    }

    var siteName = body['site'] as String?;
    var roomId = body['roomId'] as String?;
    var qQuality = body['quality'] as String?;
    var index = body['index'] as int?;

    var site = getSite(siteName ?? '');
    if (site == null || roomId == null || qQuality == null) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid parameters'}, status: HttpStatus.badRequest);
      return;
    }

    try {
      var detail = await site.getRoomDetail(roomId: roomId);
      
      // 试图从缓存里精确恢复强类型的 LivePlayQuality (包含 HuyaLineModel 等)
      var cacheKey = '$siteName:$roomId';
      var cachedQualities = _qualitiesCache[cacheKey];
      LivePlayQuality? quality;

      if (cachedQualities != null) {
        if (index != null && index >= 0 && index < cachedQualities.length) {
          quality = cachedQualities[index];
        } else {
          // 自愈逻辑：若前端传来的 index 丢失（比如因缓存加载了旧的 JS 文件），通过画质名字在缓存里模糊匹配还原
          for (var q in cachedQualities) {
            if (q.quality == qQuality) {
              quality = q;
              break;
            }
          }
        }
      }

      if (quality == null) {
        // Fallback
        quality = LivePlayQuality(quality: qQuality, data: null);
      }

      var playUrls = await site.getPlayUrls(detail: detail, quality: quality);
      var urls = playUrls.urls;

      // 虎牙源直接使用原始 FLV URL，由前端 flv.js 播放（长连接，无 token 轮询问题）
      // 不再做 flv→m3u8 域名替换，与虎牙官方网页端策略一致

      sendJsonResponse(request, {
        'success': true,
        'urls': urls,
        'headers': playUrls.headers
      });
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': 'Error: $e'}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 7.1 获取 B站 登录二维码生成参数 (结合 buvid3/buvid4 特征指纹以避开安全风控)
  if (path == '/api/bilibili/qr/generate' && method == 'GET') {
    try {
      var dio = _dio;
      // 1. 获取 buvid 凭证
      var buvidResp = await dio.get(
        "https://api.bilibili.com/x/frontend/finger/spi",
        options: Options(headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "referer": "https://passport.bilibili.com/",
        }),
      );
      var b3 = "";
      var b4 = "";
      if (buvidResp.data != null && buvidResp.data['data'] != null) {
        b3 = buvidResp.data['data']['b_3'] ?? "";
        b4 = buvidResp.data['data']['b_4'] ?? "";
      }

      // 2. 携带 buvid 获取二维码
      var response = await dio.get(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
        options: Options(headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "referer": "https://passport.bilibili.com/",
          "cookie": "buvid3=$b3;buvid4=$b4;",
        }),
      );

      var resData = Map<String, dynamic>.from(response.data);
      resData['buvid3'] = b3;
      resData['buvid4'] = b4;
      sendJsonResponse(request, resData);
    } catch (e) {
      sendJsonResponse(request, {'code': -1, 'message': e.toString()}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 7.2 轮询 B站 二维码扫码登录状态 (携带对应 buvid3/buvid4 以便通过 API 校验)
  if (path == '/api/bilibili/qr/poll' && method == 'GET') {
    var params = request.uri.queryParameters;
    var qrcodeKey = params['key'] ?? '';
    var b3 = params['b3'] ?? '';
    var b4 = params['b4'] ?? '';
    if (qrcodeKey.isEmpty) {
      sendJsonResponse(request, {'success': false, 'message': 'qrcode_key required'}, status: HttpStatus.badRequest);
      return;
    }

    try {
      var dio = _dio;
      var response = await dio.get(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
        queryParameters: {"qrcode_key": qrcodeKey},
        options: Options(headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "referer": "https://passport.bilibili.com/",
          "cookie": "buvid3=$b3;buvid4=$b4;",
        }),
      );
      
      var data = response.data['data'];
      if (data != null && data['code'] == 0) {
        // 扫码登录成功！提取 Cookie
        var setCookies = response.headers['set-cookie'] ?? [];
        var cookies = <String>[];
        for (var rawCookie in setCookies) {
          var c = rawCookie.split(';')[0];
          if (c.isNotEmpty) cookies.add(c);
        }
        // 同时把对应的 buvid 绑定写回 Cookie，保障高清获取权限
        if (b3.isNotEmpty) cookies.add("buvid3=$b3");
        if (b4.isNotEmpty) cookies.add("buvid4=$b4");

        if (cookies.isNotEmpty) {
          var cookieStr = cookies.join(';');
          config['bilibili_cookie'] = cookieStr;
          await saveConfig();
        }
      }
      sendJsonResponse(request, response.data);
    } catch (e) {
      sendJsonResponse(request, {'code': -1, 'message': e.toString()}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 7.3 手动提交备用 B站 Cookie
  if (path == '/api/bilibili/cookie' && method == 'POST') {
    try {
      var body = await readJsonBody(request);
      if (body == null) {
        sendJsonResponse(request, {'success': false, 'message': 'Invalid JSON body'}, status: HttpStatus.badRequest);
        return;
      }
      var cookieStr = body['cookie'] as String? ?? '';
      if (cookieStr.trim().isEmpty) {
        sendJsonResponse(request, {'success': false, 'message': 'Cookie cannot be empty'}, status: HttpStatus.badRequest);
        return;
      }

      config['bilibili_cookie'] = cookieStr.trim();
      await saveConfig();

      sendJsonResponse(request, {'success': true, 'message': 'Cookie saved successfully'});
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': e.toString()}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 7.4 供 DPlayer 弹幕模块初始化用的空接口，避免连接国外公共服务器超时引起卡顿
  if (path.startsWith('/api/dplayer')) {
    sendJsonResponse(request, {
      'code': 0,
      'data': []
    });
    return;
  }

  // 7.5 查询 B站 登录状态与用户信息
  if (path == '/api/bilibili/status' && method == 'GET') {
    var cookieStr = config['bilibili_cookie'] as String? ?? '';
    if (cookieStr.trim().isEmpty) {
      sendJsonResponse(request, {'success': true, 'isLogin': false});
      return;
    }

    try {
      var dio = _dio;
      var response = await dio.get(
        "https://api.bilibili.com/x/web-interface/nav",
        options: Options(headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "referer": "https://www.bilibili.com/",
          "cookie": cookieStr,
        }),
      );

      var resMap = Map<String, dynamic>.from(response.data);
      if (resMap['code'] == 0 && resMap['data'] != null && resMap['data']['isLogin'] == true) {
        var uname = resMap['data']['uname'] ?? '未知用户';
        sendJsonResponse(request, {
          'success': true,
          'isLogin': true,
          'uname': uname
        });
      } else {
        sendJsonResponse(request, {
          'success': true,
          'isLogin': false,
          'message': 'Cookie已过期'
        });
      }
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': e.toString()}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 7.6 注销 B站 登录凭证
  if (path == '/api/bilibili/logout' && method == 'POST') {
    config['bilibili_cookie'] = '';
    await saveConfig();
    sendJsonResponse(request, {'success': true, 'message': 'B站凭证已清除'});
    return;
  }

  // 8. 跨平台搜索直播间
  if (path == '/api/search' && method == 'GET') {
    var params = request.uri.queryParameters;
    var siteName = params['site'] ?? '';
    var keyword = params['keyword'] ?? '';
    var pageStr = params['page'] ?? '1';
    var page = int.tryParse(pageStr) ?? 1;

    var site = getSite(siteName);
    if (site == null || keyword.isEmpty) {
      sendJsonResponse(request, {'success': false, 'message': 'Invalid parameters'}, status: HttpStatus.badRequest);
      return;
    }

    try {
      var result = await site.searchRooms(keyword, page: page);
      var items = result.items.map((e) => {
        'roomId': e.roomId,
        'title': e.title,
        'userName': e.userName,
        'cover': e.cover,
        'online': e.online,
        'userAvatar': '',
        'liveStatus': true,
      }).toList();
      sendJsonResponse(request, {'success': true, 'hasMore': result.hasMore, 'items': items});
    } catch (e) {
      sendJsonResponse(request, {'success': false, 'message': 'Error: $e'}, status: HttpStatus.internalServerError);
    }
    return;
  }

  // 9. 关注列表管理 (GET, POST, DELETE)
  if (path == '/api/favorites') {
    var users = config['users'] as List;
    var userIndex = -1;
    for (int i = 0; i < users.length; i++) {
      if (users[i]['username'] == username) {
        userIndex = i;
        break;
      }
    }

    if (userIndex == -1) {
      sendJsonResponse(request, {'success': false, 'message': 'User not found'}, status: HttpStatus.notFound);
      return;
    }

    var userFavs = List<Map<String, dynamic>>.from(users[userIndex]['favorites'] ?? []);

    if (method == 'GET') {
      // 批量获取关注列表最新的直播状态
      var updatedFavs = <Map<String, dynamic>>[];
      for (var fav in userFavs) {
        var site = getSite(fav['site'] ?? '');
        var roomId = fav['roomId'] ?? '';
        if (site != null && roomId.isNotEmpty) {
          try {
            var detail = await site.getRoomDetail(roomId: roomId);
            fav['title'] = detail.title;
            fav['userName'] = detail.userName;
            fav['cover'] = detail.cover;
            fav['online'] = detail.online;
            fav['liveStatus'] = detail.status;
            fav['userAvatar'] = detail.userAvatar;
          } catch (e) {
            // 获取失败则保持旧数据
          }
        }
        updatedFavs.add(fav);
      }
      sendJsonResponse(request, {'success': true, 'favorites': updatedFavs});
      return;
    }

    if (method == 'POST') {
      var body = await readJsonBody(request);
      if (body == null) {
        sendJsonResponse(request, {'success': false, 'message': 'Invalid JSON body'}, status: HttpStatus.badRequest);
        return;
      }
      var site = body['site'] as String?;
      var roomId = body['roomId'] as String?;
      var title = body['title'] as String? ?? '';
      var userName = body['userName'] as String? ?? '';
      var cover = body['cover'] as String? ?? '';
      var userAvatar = body['userAvatar'] as String? ?? '';

      if (site == null || roomId == null) {
        sendJsonResponse(request, {'success': false, 'message': 'Site and roomId required'}, status: HttpStatus.badRequest);
        return;
      }

      // 去重
      userFavs.removeWhere((item) => item['site'] == site && item['roomId'] == roomId);
      userFavs.insert(0, {
        'site': site,
        'roomId': roomId,
        'title': title,
        'userName': userName,
        'cover': cover,
        'userAvatar': userAvatar,
      });

      config['users'][userIndex]['favorites'] = userFavs;
      await saveConfig();

      sendJsonResponse(request, {'success': true, 'message': 'Added to favorites'});
      return;
    }

    if (method == 'DELETE') {
      var body = await readJsonBody(request);
      if (body == null) {
        sendJsonResponse(request, {'success': false, 'message': 'Invalid JSON body'}, status: HttpStatus.badRequest);
        return;
      }
      var site = body['site'] as String?;
      var roomId = body['roomId'] as String?;

      if (site == null || roomId == null) {
        sendJsonResponse(request, {'success': false, 'message': 'Site and roomId required'}, status: HttpStatus.badRequest);
        return;
      }

      userFavs.removeWhere((item) => item['site'] == site && item['roomId'] == roomId);
      config['users'][userIndex]['favorites'] = userFavs;
      await saveConfig();

      sendJsonResponse(request, {'success': true, 'message': 'Removed from favorites'});
      return;
    }
  }

  // 未匹配的 API
  sendJsonResponse(request, {'success': false, 'message': 'API Route Not Found'}, status: HttpStatus.notFound);
}

void handleWebSocketDanmaku(HttpRequest request) async {
  if (!WebSocketTransformer.isUpgradeRequest(request)) {
    request.response.statusCode = HttpStatus.badRequest;
    request.response.write('Only WebSocket connections are allowed');
    await request.response.close();
    return;
  }

  var params = request.uri.queryParameters;
  var siteName = params['site'] ?? '';
  var roomId = params['roomId'] ?? '';

  var site = getSite(siteName);
  if (site == null || roomId.isEmpty) {
    request.response.statusCode = HttpStatus.badRequest;
    request.response.write('Invalid parameters');
    await request.response.close();
    return;
  }

  WebSocket socket;
  try {
    socket = await WebSocketTransformer.upgrade(request);
  } catch (e) {
    print('Failed to upgrade WebSocket: $e');
    return;
  }

  print('WebSocket client connected for $siteName - $roomId');

  LiveDanmaku? danmaku;
  bool isClosed = false;

  socket.done.then((_) async {
    isClosed = true;
    print('WebSocket client disconnected for $siteName - $roomId');
    if (danmaku != null) {
      try {
        await danmaku!.stop();
      } catch (e) {
        print('Error stopping danmaku: $e');
      }
    }
  });

  try {
    var detail = await site.getRoomDetail(roomId: roomId);
    danmaku = site.getDanmaku();
    danmaku.onMessage = (LiveMessage msg) {
      if (isClosed) return;
      if (msg.type == LiveMessageType.chat) {
        var data = {
          'type': 'chat',
          'userName': msg.userName,
          'message': msg.message,
        };
        socket.add(json.encode(data));
      } else if (msg.type == LiveMessageType.online) {
        var data = {
          'type': 'online',
          'online': msg.data,
        };
        socket.add(json.encode(data));
      }
    };

    danmaku.onClose = (err) {
      if (isClosed) return;
      print('Danmaku subscription closed: $err');
      socket.close();
    };

    await danmaku.start(detail.danmakuData);
  } catch (e) {
    print('Error starting danmaku subscription: $e');
    if (!isClosed) {
      socket.add(json.encode({
        'type': 'error',
        'message': 'Failed to connect to danmaku: $e'
      }));
      socket.close();
    }
  }
}

void handleStaticFile(HttpRequest request, String webPath) async {
  var path = request.uri.path;
  if (path == '/') {
    path = '/index.html';
  }

  // 简单防止路径遍历攻击
  if (path.contains('..')) {
    request.response.statusCode = HttpStatus.forbidden;
    request.response.write('Forbidden');
    await request.response.close();
    return;
  }

  var file = File('$webPath$path');
  if (await file.exists()) {
    var mime = getContentType(path);
    request.response.headers.contentType = ContentType.parse(mime);
    try {
      await file.openRead().pipe(request.response);
    } catch (e) {
      print('Error serving file: $e');
    }
  } else {
    request.response.statusCode = HttpStatus.notFound;
    request.response.write('404 Not Found');
    await request.response.close();
  }
}

String getContentType(String path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.ico')) return 'image/x-icon';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain';
}
