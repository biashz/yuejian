; 只改桌面快捷方式的显示名，安装目录、可执行文件名、开始菜单项与卸载项保持 productName 不变。
; 「阅笺」用 Unicode 转义书写，避免 .nsh 文件编码被 makensis 按系统代码页误判。

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 安装器已按 PRODUCTNAME 建好快捷方式，这里改成中文显示名
  Delete "$DESKTOP\${U+9605}${U+7B3A}.lnk"
  Rename "$DESKTOP\${PRODUCTNAME}.lnk" "$DESKTOP\${U+9605}${U+7B3A}.lnk"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载器只会删 PRODUCTNAME 的快捷方式，改名后的需要自己清掉
  Delete "$DESKTOP\${U+9605}${U+7B3A}.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
