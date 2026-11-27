; 中文向导安装时，把快捷方式与卸载列表里的产品名显示为「阅笺」；
; 英文向导安装时保持 productName（YueJian Reader）。
; 安装目录、可执行文件名与注册表键始终使用 productName，避免升级与路径问题。
; 「阅笺」用 Unicode 转义书写，避免 .nsh 文件编码被 makensis 按系统代码页误判。
;
; 时序要点：
;   * 桌面与开始菜单快捷方式都在安装段创建（见 installer.nsi 的 Section Install），
;     因此 POSTINSTALL 一次改名即可覆盖交互 / 被动 / 静默三种安装；
;   * 创建与改名对 Explorer 都是「悄悄发生」的两步，必须紧接着发 SHChangeNotify，
;     否则桌面要等下一个 shell 事件（例如启动应用）才肯把新图标画出来。
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

; 让 Explorer 立刻重读桌面与开始菜单目录。
; 快捷方式是安装器进程里创建又改名的，资源管理器不知道有这个新文件；
; SHCNE_UPDATEDIR(0x1000) + SHCNF_PATHW(0x5) 只刷新这两个目录，不做全盘图标重建。
Function YueJianNotifyShell
  System::Call 'shell32::SHChangeNotify(i 0x1000, i 0x5, w "$DESKTOP", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x1000, i 0x5, w "$SMPROGRAMS", p 0)'
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 所有安装模式的快捷方式此时都已创建，改名后立刻通知 shell
  Call YueJianRenameShortcuts
  Call YueJianNotifyShell
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
