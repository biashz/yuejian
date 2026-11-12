; 只改桌面快捷方式的显示名，安装目录、可执行文件名、开始菜单项与卸载项保持 productName 不变。
; 「阅笺」用 Unicode 转义书写，避免 .nsh 文件编码被 makensis 按系统代码页误判。
;
; 时序要点：交互安装时，桌面快捷方式是在「完成」页点击完成按钮时才由
; CreateOrUpdateDesktopShortcut 创建的，晚于 NSIS_HOOK_POSTINSTALL。
; 因此交互安装的改名放在 .onGUIEnd（安装器界面关闭前）执行，
; POSTINSTALL 只负责静默/被动安装（无完成页）这一条路径。
; 用原生命令 IfFileExists 而非 ${If} ${FileExists}，后者会误解析 ${PRODUCTNAME}。

; 交互安装：完成页创建完成后、安装器界面收起前改名
Function .onGUIEnd
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 yuejian_gui_no_shortcut
    Delete "$DESKTOP\${U+9605}${U+7B3A}.lnk"
    Rename "$DESKTOP\${PRODUCTNAME}.lnk" "$DESKTOP\${U+9605}${U+7B3A}.lnk"
  yuejian_gui_no_shortcut:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 静默 / 被动安装没有完成页，快捷方式已在安装段建好，这里直接改名
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 yuejian_post_no_shortcut
    Delete "$DESKTOP\${U+9605}${U+7B3A}.lnk"
    Rename "$DESKTOP\${PRODUCTNAME}.lnk" "$DESKTOP\${U+9605}${U+7B3A}.lnk"
  yuejian_post_no_shortcut:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载器只删 PRODUCTNAME 的快捷方式，改名后的需要自己清掉
  Delete "$DESKTOP\${U+9605}${U+7B3A}.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
