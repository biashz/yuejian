; 中文向导安装时，把快捷方式与卸载列表里的产品名显示为「阅笺」；
; 英文向导安装时保持 productName（YueJian Reader）。
; 安装目录、可执行文件名与注册表键始终使用 productName，避免升级与路径问题。
; 「阅笺」用 Unicode 转义书写，避免 .nsh 文件编码被 makensis 按系统代码页误判。
;
; 时序要点：
;   * 开始菜单快捷方式在安装段创建，POSTINSTALL 即可改名；
;   * 交互安装的桌面快捷方式在「完成」页才创建，晚于 POSTINSTALL，
;     因此交互安装的桌面改名放在 .onGUIEnd（安装器界面收起前），
;     POSTINSTALL 负责静默 / 被动安装（无完成页）这一条路径。
; 用原生命令 IfFileExists / StrCmp，避免 LogicLib 误解析 ${PRODUCTNAME}。

; 中文向导下：桌面 + 开始菜单快捷方式由 YueJian Reader.lnk 改名为 阅笺.lnk
Function YueJianRenameShortcuts
  StrCmp $LANGUAGE ${LANG_SIMPCHINESE} 0 yuejian_rename_done

  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 yuejian_rename_startmenu
    Delete "$DESKTOP\${U+9605}${U+7B3A}.lnk"
    Rename "$DESKTOP\${PRODUCTNAME}.lnk" "$DESKTOP\${U+9605}${U+7B3A}.lnk"

  yuejian_rename_startmenu:
  ; 快捷方式位置与模板创建时保持一致：有开始菜单文件夹配置才落在子目录里
  !if "${STARTMENUFOLDER}" != ""
    IfFileExists "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" 0 yuejian_rename_done
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${U+9605}${U+7B3A}.lnk"
      Rename "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$SMPROGRAMS\$AppStartMenuFolder\${U+9605}${U+7B3A}.lnk"
  !else
    IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 yuejian_rename_done
      Delete "$SMPROGRAMS\${U+9605}${U+7B3A}.lnk"
      Rename "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$SMPROGRAMS\${U+9605}${U+7B3A}.lnk"
  !endif

  yuejian_rename_done:
FunctionEnd

; 交互安装：完成页创建桌面快捷方式后、安装器界面收起前改名
Function .onGUIEnd
  Call YueJianRenameShortcuts
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 开始菜单快捷方式此时已创建；静默 / 被动安装的桌面快捷方式也已创建
  Call YueJianRenameShortcuts
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

; 卸载器只删 productName 的快捷方式，改名后的需要自己清掉（更新模式不处理）
Function un.YueJianDeleteChineseShortcuts
  Delete "$DESKTOP\${U+9605}${U+7B3A}.lnk"

  !if "${STARTMENUFOLDER}" != ""
    Delete "$SMPROGRAMS\$AppStartMenuFolder\${U+9605}${U+7B3A}.lnk"
    RMDir "$SMPROGRAMS\$AppStartMenuFolder"
  !else
    Delete "$SMPROGRAMS\${U+9605}${U+7B3A}.lnk"
  !endif
FunctionEnd

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Call un.YueJianDeleteChineseShortcuts

    ; 用户数据（书架 / 设置 / WebView2 缓存）随安装位置存放在 $INSTDIR\data，
    ; 模板内置的清理只针对 $APPDATA\$BUNDLEID，故勾选「删除应用数据」时在这里补删，
    ; 并移除因 data 非空而未被模板 RMDir 删掉的安装目录
    ${If} $DeleteAppDataCheckboxState = 1
      RmDir /r "$INSTDIR\data"
      RMDir "$INSTDIR"
    ${EndIf}
  ${EndIf}
!macroend
