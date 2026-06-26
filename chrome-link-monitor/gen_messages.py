import pathlib

def to_js_string(s):
    out = []
    for ch in s:
        if ch == "'":
            out.append("\\'")
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ord(ch) < 128:
            out.append(ch)
        else:
            out.append("\\u%04x" % ord(ch))
    return "'" + "".join(out) + "'"

strings = {
    'EXT_TITLE': '链接变更监控',
    'AUDIO_REASON': '播放链接变更提醒音',
    'BADGE_CHANGED': '变',
    'BADGE_TEST': '测',
    'TITLE_CHANGED_PREFIX': '【内容已变更】',
    'LOG_NOTIFY_FAIL': '链接监控通知创建失败',
    'LOG_AUDIO_FAIL': '链接监控播放提醒音失败',
    'LOG_CHECK_FAIL': '链接监控检查失败',
    'TEST_TITLE': '通知测试 - 请查看桌面右下角',
    'TEST_MSG': '如果你看到这条通知并听到三声提示音，说明提醒功能正常。此通知需手动关闭才会消失。',
    'CHANGE_LINE': '  监控的链接内容已发生变化',
    'CHANGE_CLICK': '点击此通知可打开链接',
    'CHANGE_TITLE': '检测到内容变更! 请立即查看',
    'CHANGE_TITLE_UPDATED': '已更新并跳转',
    'CHANGE_CLICK_JUMP': '点击此通知可打开链接并跳转',
    'REG_TITLE_MULTI': '已开始多链接监控',
    'REG_MSG_MULTI_PREFIX': '共监控 %d 个链接，将定时检查内容是否变更',
    'STOP_MSG_MULTI': '已停止全部链接监控',
    'MENU_APPEND': '添加到监控列表',
    'LOGIN_HINT': '（该页面需要登录，请保持已登录的标签页打开）',
    'REQUEST_FAIL': '请求失败',
    'HTTP_503_HINT': '（目标站点暂时不可用 503；若测试 httpbin.org 请改用 httpbingo.org/uuid）',
    'HTTP_504_HINT': '（网关超时 504，站点繁忙；请保持该页标签打开后重试）',
    'PORTAL_TAB_HINT': '（请保持该招标/公共资源页面标签打开，扩展将优先从标签页读取）',
    'ASK_OPEN_TITLE': '链接监控已开启',
    'ASK_OPEN_MSG': '是否以后在打开浏览器时自动打开监控页面？',
    'BTN_YES': '是，自动打开',
    'BTN_NO': '否，不自动打开',
    'REG_TITLE': '已开始监控链接',
    'REG_MSG_PREFIX': '将定时检查以下内容是否变更：\n',
    'STOP_TITLE': '已关闭链接监控',
    'STOP_MSG': '将不再定时检查链接内容变更',
    'FAIL_TITLE': '链接检查失败',
    'MENU_ENABLE': '开启链接监控',
    'MENU_DISABLE': '关闭链接监控',
    'WELCOME_TITLE': '链接变更监控已安装',
    'WELCOME_MSG': '将使用 Windows 系统通知栏与 Chrome 弹窗提醒。请在系统设置中允许 Chrome 通知。',
    'POPUP_BTN_OPEN': '打开链接',
    'POPUP_BTN_CLOSE': '关闭',
    'OVERLAY_TAG': '链接变更监控提醒',
    'THROTTLE_ASK_TITLE': '弹窗提醒过于频繁',
    'THROTTLE_ASK_MSG': '60 分钟内弹窗已超过 40 次。选择「减缓」将暂停 Chrome 弹窗与网页遮罩，并仅把触发过频的链接检查间隔改为 30 分钟（其他链接间隔不变，仍保留系统通知）。',
    'THROTTLE_BTN_PAUSE': '减缓（30 分钟间隔）',
    'THROTTLE_BTN_CONTINUE': '继续弹窗提醒',
    'THROTTLE_PAUSED_TITLE': '已减缓提醒频率',
    'THROTTLE_PAUSED_MSG': 'Chrome 弹窗与网页遮罩已关闭，仅该链接的检查间隔已改为 30 分钟，其他链接间隔不变，系统通知仍保留。',
    'NOISE_TITLE': '检测到页面装饰变化（可能为广告/弹窗）',
    'NOISE_LINE': '  正文核心内容未变，变化可能来自广告、浮层或页面装饰',
    'NOISE_HINT': '若正文（如招投标状态）已变更但未提醒，请保持详情页标签打开后重试',
    'CHANGE_KIND_CONTENT': '正文内容已变更',
    'CHANGE_KIND_NOISE': '可能仅为广告/弹窗变化',
    'LOG_CHECK_OK': '链接监控检查完成',
    'LOG_CHECK_CONTENT': '正文内容变更',
    'LOG_CHECK_NOISE': '仅装饰/广告变化，已轻量提醒',
    'LOG_CHECK_NOISE_SKIP': '仅装饰/广告变化，已忽略',
    'LOG_CHECK_SAME': '内容无变化',
    'MENU_ENABLE_PAGE': '监控当前标签页网址',
    'MENU_ENABLE_PICKED': '开启最近点击项监控',
    'MENU_ENABLE_PICKED_HINT': '请用点选模式或点链接旁「监控」按钮',
    'MENU_ENABLE_SELECTION': '监控选中的网址',
    'OMNIBOX_DEFAULT': '按 Enter 监控当前标签页；或输入网址后按 Enter',
    'OMNIBOX_CURRENT_TAB': '监控当前标签页网址',
    'OMNIBOX_ENTER_URL': '监控网址：%s',
    'OMNIBOX_NO_TAB': '无法获取当前标签页（请在普通网页上使用）',
    'OMNIBOX_BAD_URL': '请输入有效网址',
    'AHTBA_BAR_HINT': '本站禁用链接右键，可用页面空白处右键或右下角工具条',
    'POPUP_MONITOR_TAB': '监控当前标签页',
    'POPUP_MONITOR_PICKED': '监控页面上最近点击的链接',
    'POPUP_NO_PICKED': '请先在页面上点击要监控的条目',
    'POPUP_AUTO_OPEN_LINK': '选择链接后自动打开监控页面',
    'REG_OK': '已开始监控',
}

lines = ["'use strict';", "", "var MSG = {"]
for key, value in strings.items():
    lines.append("  %s: %s," % (key, to_js_string(value)))
lines.append("};")

path = pathlib.Path(__file__).resolve().parent / 'background' / 'messages.js'
path.write_text("\n".join(lines) + "\n", encoding='ascii')
print('ok', path)
