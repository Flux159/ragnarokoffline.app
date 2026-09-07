// Styles are applied only to named native components, through client API 1.
export const buttonStyle = `
.ro-mobile-button, ui-button[aria-label], button[data-mobile-label] {
 min-height:44px!important; min-width:44px!important; box-sizing:border-box; border:1px solid #b4a27e!important;
 border-radius:6px; background:#f7f0df!important; color:#312a1d; font:14px system-ui!important;
 padding:9px!important; text-align:center; line-height:24px!important; touch-action:manipulation;
}
ui-button[aria-label] {width:auto!important;white-space:nowrap;}
.ro-mobile-toolbar {display:flex;gap:6px;padding:8px;flex-wrap:wrap;background:#efe4ca;position:sticky;bottom:0;z-index:20;}
.ro-mobile-toolbar[hidden]{display:none!important;}
.ro-mobile-toolbar input[type=number]{width:80px!important;min-height:44px;font:16px system-ui;box-sizing:border-box;}
.ro-mobile-selected {outline:2px solid #e0ad46!important;outline-offset:-2px;}
`;
const safePanel = `
:host {position:fixed!important;left:max(8px,env(safe-area-inset-left))!important;top:calc(var(--ro-view-top,0px) + 60px)!important;
 max-width:calc(var(--ro-view-width,100vw) - 16px)!important;max-height:calc(var(--ro-view-height,100dvh) - 80px)!important;
 box-sizing:border-box;overflow:auto!important;overscroll-behavior:contain;touch-action:pan-x pan-y;font-size:14px!important;z-index:calc(4000 + var(--ro-native-z,50))!important;}
input[type=text],input[type=password],input[type=number],textarea,select {font-size:16px!important;min-height:44px;box-sizing:border-box;}
`;
export function componentStyle(name) {
  if (name === 'SkillDescription') return `${safePanel}${buttonStyle}
:host {z-index:5200!important;left:max(16px,env(safe-area-inset-left))!important;top:calc(var(--ro-view-top,0px) + 72px)!important;}
#SkillDescription {position:relative!important;box-sizing:border-box;background:#fff;box-shadow:0 4px 16px #0005;}
.ui-component-root {position:relative!important;width:min(340px,calc(var(--ro-view-width,100vw) - 32px))!important;box-sizing:border-box;}
#SkillDescription .close {position:sticky!important;top:0;float:right;z-index:1;width:auto!important;height:auto!important;}
.content {clear:both;width:100%!important;box-sizing:border-box;overflow-wrap:anywhere;}
`;
  if (name === "WinPopup")
    return `${safePanel}${buttonStyle}
:host{width:min(360px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;z-index:5100!important;}
#win_popup{position:relative!important;width:100%!important;height:auto!important;background:#fff7e8!important;border:1px solid #b4a27e;border-radius:8px;padding:12px;box-sizing:border-box;}
#win_popup .container,#win_popup .buttonscontainer,#win_popup .btns{position:static!important;width:100%!important;height:auto!important;}
#win_popup .text{font:16px/1.4 system-ui;padding:4px 0 16px;}
#win_popup .btns{display:flex;flex-wrap:wrap;gap:6px;}
#win_popup .btn{position:static!important;flex:1;width:auto!important;margin:0!important;}
`;
  if (name === "InputBox")
    return `${safePanel}${buttonStyle}
:host{width:min(320px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;z-index:5100!important;top:calc(var(--ro-view-top,0px) + 72px)!important;}
#inputbox,#inputbox .border{width:100%!important;height:auto!important;box-sizing:border-box;padding:12px;}
#inputbox .text{width:100%!important;height:auto!important;font:16px/1.4 system-ui;margin-bottom:8px;}
#inputbox input{width:100%!important;height:44px!important;padding:8px;margin:0;box-sizing:border-box;}
#inputbox ui-button{position:static!important;display:block!important;margin-top:8px;}
`;
  if (name === "Storage")
    return `${safePanel}${buttonStyle}
:host{width:min(420px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;}
.ui-component-root{display:flex;flex-direction:column;height:auto!important;}
#Storage{position:relative!important;width:100%!important;background:#fff7e8;}
#Storage .titlebar{height:44px!important;display:flex;align-items:center;}
#Storage .titlebar .text{font:16px system-ui!important;width:auto!important;}
#Storage .panel table,#Storage .panel tbody,#Storage .panel tr,#Storage .panel td,#Storage .footer{display:block;width:100%!important;box-sizing:border-box;height:auto!important;}
#Storage .tabs{display:flex!important;flex-wrap:wrap;gap:4px;background:none!important;border:0!important;padding:4px;}
#Storage .tabs button{flex:1 0 auto;width:auto!important;min-width:44px!important;min-height:44px!important;height:auto!important;}
#Storage .container{padding:0!important;border:0!important;}
#Storage .content{width:100%!important;height:220px!important;min-height:100px!important;max-height:32vh;overflow:auto!important;background-image:none!important;background-color:#fff7e8;}
#Storage .content .item{position:relative!important;display:flex!important;align-items:center;width:100%!important;min-height:48px;box-sizing:border-box;border-bottom:1px solid #d6c7a7;}
#Storage .content .icon{position:static!important;min-width:32px!important;width:32px!important;height:32px!important;background-position:center;background-repeat:no-repeat;}
#Storage .content .name,#Storage .content .amount{position:static!important;font:14px system-ui!important;width:auto!important;height:auto!important;margin:0 6px;}
#Storage .filter-buttons,#Storage .extend,#Storage .item_num{display:none!important;}
#Storage .footer{padding:8px;background:#efe4ca!important;}
#Storage .footer .search-container{position:static!important;width:100%!important;display:flex;gap:4px;height:auto!important;padding:0!important;box-sizing:border-box;}
#Storage .search-input{flex:1;width:0!important;min-width:0;}
#Storage .search-button{margin:0!important;flex:none;}
#Storage .footer .close{position:static!important;display:block;margin-top:8px;}
`;
  if (name === "NpcStore")
    return `${safePanel}${buttonStyle}
:host{width:min(640px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;}
.ui-component-root{height:auto!important;}
#NpcStore{position:relative!important;width:100%!important;height:auto!important;display:flex;flex-direction:column;gap:8px;}
#NpcStore > div{position:relative!important;inset:auto!important;width:100%!important;height:auto!important;box-sizing:border-box;background:#fff7e8;border:1px solid #bdac86;}
#NpcStore .titlebar > ui-image,#NpcStore .footer > ui-image{display:none!important;}
#NpcStore .titlebar,#NpcStore .footer{background-image:none!important;background-color:#e9dec5!important;}
#NpcStore .titlebar{background:#e9dec5;height:auto!important;min-height:36px;display:flex;align-items:center;font:16px system-ui;}
#NpcStore .titlebar .text{position:static!important;white-space:normal;padding:6px;}
#NpcStore .container{padding:0!important;border:0!important;}
#NpcStore .container > ui-image,#NpcStore .resize{display:none!important;}
#NpcStore .content{height:160px!important;min-height:60px;max-height:25vh;overflow:auto!important;background-image:none!important;}
#NpcStore .OutputWindow .content{height:100px!important;max-height:20vh;}
#NpcStore .content .item{min-height:48px;box-sizing:border-box;border-bottom:1px solid #d5c7a7;}
#NpcStore .content .item .name{width:calc(100% - 145px)!important;white-space:normal;font:14px/1.3 system-ui;top:8px!important;}
#NpcStore .footer{height:auto!important;min-height:32px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:6px;box-sizing:border-box;}
#NpcStore .footer .btn{position:static!important;min-height:44px!important;}
#NpcStore .footer .total{position:static!important;width:100%;font:14px system-ui;}
#NpcStore .selectall{min-width:44px;min-height:44px;}
`;
  if (name === "Escape")
    return `${safePanel}${buttonStyle}
:host{width:min(340px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;}
#Escape{position:relative!important;width:100%!important;background:#fff7e8!important;box-sizing:border-box;padding:12px;}
#Escape .top{height:32px!important;}#Escape .top .node{display:none;}
#Escape .container{display:flex;flex-direction:column;gap:8px;width:auto!important;padding:0!important;}
#Escape .container button{width:100%!important;height:auto!important;min-height:44px!important;}
`;
  if (/^Equipment/.test(name))
    return `${safePanel}${buttonStyle}
:host{width:min(420px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;}
.ui-component-root{display:flex;flex-direction:column;height:auto!important;width:100%;}
#EquipmentV4{width:100%!important;background:#fff7e8;}
#EquipmentV4 .titlebar{width:100%!important;height:44px!important;display:flex;align-items:center;}
#EquipmentV4 .titlebar .left{flex:1;}#EquipmentV4 .titlebar .clear,#EquipmentV4 .titlebar .base:not(.close){display:none!important;}
#EquipmentV4 .titlebar .text{width:auto!important;font:16px system-ui!important;}
#EquipmentV4 .tab-manager{height:auto!important;min-height:44px;overflow:auto;}
#EquipmentV4 .tab a{min-height:44px;min-width:64px;box-sizing:border-box;padding:12px 3px;}
#EquipmentV4 .panel{height:auto!important;min-height:240px;}
#EquipmentV4 table.content{width:100%!important;height:auto!important;min-height:220px;background-image:none!important;}
#EquipmentV4 .col1,#EquipmentV4 .col3{height:44px!important;min-width:100px;}
#EquipmentV4 .item{min-height:44px;display:flex;align-items:center;border:1px solid #d5c8ae;box-sizing:border-box;}
#EquipmentV4 .item span{height:auto!important;min-height:32px;white-space:normal;word-break:normal;font:13px/1.3 system-ui;}
#EquipmentV4 .view_status{display:none!important;}
`;
  if (/^SkillList/.test(name))
    return `${safePanel}${buttonStyle}
:host{width:min(480px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;}
.ui-component-root{display:flex;flex-direction:column;height:auto!important;width:100%;}
#SkillListV2{position:relative!important;width:100%!important;box-sizing:border-box;}
#SkillListV2 .titlebar{height:44px!important;display:flex;align-items:center;justify-content:space-between;}
#SkillListV2 .titlebar .left{height:auto;}#SkillListV2 .titlebar .clear,#SkillListV2 .titlebar .base:not(.close),#SkillListV2 .view_skill_info{display:none!important;}
#SkillListV2 .titlebar .text{font:16px system-ui!important;width:auto!important;}
#SkillListV2 .content{width:100%!important;box-sizing:border-box;height:300px!important;padding:4px!important;}
#SkillListV2 .contentbig{max-width:100%;overflow:auto;}
#SkillListV2 .tabs-mini{display:flex;gap:3px;min-height:280px!important;}
#SkillListV2 .tab-mini{display:contents;}
#SkillListV2 .tab-label-mini{writing-mode:horizontal-tb!important;text-orientation:mixed;position:static!important;left:0!important;width:auto!important;min-width:44px;height:44px;box-sizing:border-box;padding:12px 6px;margin:0!important;z-index:3;}
#SkillListV2 .tab-content-mini{top:48px!important;height:calc(100% - 48px)!important;pointer-events:none;}
#SkillListV2 .tab-switch-mini:checked + label + .tab-content-mini{pointer-events:auto;}
#SkillListV2 .content table{width:100%;}#SkillListV2 .content .skill{height:52px;}
#SkillListV2 .levelup,#SkillListV2 .reduce,#SkillListV2 .increase{min-width:44px!important;min-height:44px!important;}
`;
  if (name === "Quest")
    return `${safePanel}${buttonStyle}
:host{width:min(440px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;background:#fff7e8;}
#Quest{width:100%!important;height:auto!important;min-height:320px;}
#Quest .titlebar{display:flex;flex-direction:column;width:100%!important;height:auto!important;background-image:none!important;}
#Quest .quest-top-panel{width:100%!important;min-height:44px;align-items:center;font:16px system-ui;}
#Quest .quest-top-panel-text{margin:8px!important;}
#Quest .quest-left-panel{height:auto!important;width:100%!important;}
#Quest .quest-menu{display:flex;width:100%;gap:4px;}
#Quest .quest-menu-item{height:44px!important;width:auto!important;flex:1;background:#eadfc6!important;text-align:center;line-height:44px;font:14px/44px system-ui;cursor:pointer;}
#Quest .quest-right-panel{width:100%!important;height:260px!important;max-height:38vh;overflow:auto;}
#Quest .quest-list,#Quest .quest-item{max-width:100%;box-sizing:border-box;}
#Quest .quest-bottom-panel{position:relative!important;width:100%!important;height:52px!important;display:flex;align-items:center;justify-content:space-between;}
#Quest .close-quest-container{position:static!important;margin-left:auto;width:auto!important;height:auto!important;}
`;
  if (
    /^BasicInfo|^MiniMap|^ShortCut$|^StatusIcons$|^MapName$|^CashShopIcon$|^JoystickUI$/.test(
      name,
    )
  )
    return ":host {display:none!important;}";
  if (name === "MobileUI")
    return `
:host{display:block!important;left:0!important;top:0!important;width:100%!important;height:100%!important;pointer-events:none;z-index:1200!important;}
#MobileUI > :not(#joystickContainer) {display:none!important;}
#MobileUI #joystickContainer {display:block!important;visibility:visible!important;position:fixed!important;
 left:calc(env(safe-area-inset-left) + 18px)!important;bottom:calc(env(safe-area-inset-bottom) + 18px)!important;
 width:calc(104px * var(--ro-ui-scale,1))!important;height:calc(104px * var(--ro-ui-scale,1))!important;}
#MobileUI #joystickBase {visibility:visible!important;border:2px solid #e9d5a18c;background:#211c16aa;box-shadow:0 3px 18px #0006;touch-action:none;}
#MobileUI #joystickThumb {width:44px!important;height:44px!important;background:radial-gradient(circle,#fff7df,#ad925d);pointer-events:none;}
`;
  if (/^WinLogin/.test(name))
    return `${buttonStyle}
:host {position:fixed!important;top:calc(var(--ro-view-top,0px) + max(12px,(var(--ro-view-height,100dvh) - 344px)/2))!important;
 left:max(12px,calc((var(--ro-view-width,100vw) - 340px)/2))!important;width:min(340px,calc(var(--ro-view-width,100vw) - 24px))!important;
 height:auto!important;max-height:calc(var(--ro-view-height,100dvh) - 24px)!important;overflow:auto!important;}
#WinLogin {position:relative!important;width:100%!important;height:auto!important;background:#fff9ecef;border:1px solid #b4a27e;border-radius:12px;box-sizing:border-box;padding:16px;}
#WinLogin > ui-image,#WinLogin .win_login > ui-image {display:none!important;}
#WinLogin .win_login {display:grid;grid-template-columns:1fr 1fr;gap:8px;height:auto!important;width:100%!important;background-image:none!important;background-color:transparent!important;}
#WinLogin .win_login input,#WinLogin .win_login button,#WinLogin .win_login select {position:static!important;inset:auto!important;box-sizing:border-box;}
#WinLogin input.user,#WinLogin input.pass {grid-column:1/-1;width:100%!important;min-height:44px!important;font:16px system-ui!important;background:white!important;border:1px solid #b4a27e!important;border-radius:5px;text-align:left!important;padding:10px!important;}
#WinLogin .connect {grid-column:1/-1;width:100%!important;height:48px!important;background:#59472c!important;color:white;font-weight:bold!important;}
#WinLogin .save {display:none!important;}
#WinLogin .btn {width:auto!important;height:auto!important;min-height:44px!important;background:#eee3c9!important;border:1px solid #b4a27e!important;border-radius:5px;color:#312a1d;font:14px system-ui!important;}
#WinLogin .exit {display:none!important;}
#WinLogin .connect {background:#59472c!important;color:white!important;}
#WinLogin .replay {grid-column:2;grid-row:5;}
#WinLogin .signup {grid-column:1;grid-row:5;}
.ro-mobile-title {grid-column:1/-1;font:600 22px system-ui;color:#352a1a;margin:0 0 8px;}
`;
  if (/^CharSelect/.test(name))
    return `${buttonStyle}
:host {position:fixed!important;inset:0!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;overflow:auto!important;}
#CharSelectV4 {position:relative!important;min-width:0!important;min-height:100%!important;padding:60px 8px 16px;box-sizing:border-box;display:block!important;}
#CharSelectV4 .char_select_container {position:relative!important;display:flex!important;flex-direction:column!important;max-width:640px;margin:auto;padding:0!important;}
#CharSelectV4 .char_list {display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));max-width:none!important;width:100%!important;min-height:200px;height:auto!important;max-height:calc(var(--ro-view-height,100dvh) - 190px)!important;gap:4px;overflow:auto;}
#CharSelectV4 .char_canvas {width:157px!important;max-width:100%;justify-self:center;}
#CharSelectV4 .charinfo {display:none!important;}
#CharSelectV4 .btns {position:sticky!important;bottom:0!important;left:auto!important;right:auto!important;width:auto!important;height:auto!important;display:flex;gap:6px;background:#fff4dd;padding:8px;}
#CharSelectV4 .btns .btn {position:static!important;}
#CharSelectV4 .cancel {position:fixed!important;right:8px!important;top:8px!important;z-index:40;}
#CharSelectV4 .slotinfo,#CharSelectV4 .pageinfo {display:none!important;}
@media(min-width:600px){#CharSelectV4 .char_list{grid-template-columns:repeat(3,minmax(0,1fr));}}
`;
  if (/^CharCreate/i.test(name))
    return `${safePanel}${buttonStyle}
:host {width:calc(var(--ro-view-width,100vw) - 16px)!important;max-width:620px!important;height:auto!important;background:#fff7e8;border:1px solid #b4a27e;border-radius:8px;}
#charcreate_v4 {position:relative!important;display:grid!important;grid-template-columns:1fr!important;gap:12px;width:auto!important;height:auto!important;padding:12px;background:#fff7e8!important;}
#charcreate_v4 > ui-image {display:none!important;}
#charcreate_v4 .title,#charcreate_v4 #style,#charcreate_v4 #hair_setting {position:static!important;width:auto!important;height:auto!important;}
#charcreate_v4 .human_label,#charcreate_v4 .doram_label {position:relative!important;display:flex!important;align-items:center;width:auto!important;min-height:110px;height:auto!important;inset:auto!important;border:1px solid #b4a27e;border-radius:6px;background:#ece3d0!important;margin-bottom:8px;}
#charcreate_v4 .human_title,#charcreate_v4 .doram_title {position:static!important;color:#32291e!important;width:64px!important;min-width:64px;font-weight:bold;}
#charcreate_v4 .human_desc,#charcreate_v4 .doram_desc {position:static!important;width:auto!important;height:auto!important;flex:1;}
#charcreate_v4 .chargen,#charcreate_v4 .chargen_doram {order:-1;min-width:65px;}
#charcreate_v4 .human canvas,#charcreate_v4 .doram canvas {position:static!important;}
#charcreate_v4 #style .gender {position:static!important;display:flex;width:auto!important;height:auto!important;gap:8px;}
#charcreate_v4 #male_container,#charcreate_v4 #female_container {position:static!important;width:90px!important;height:44px!important;}
#charcreate_v4 .male_button,#charcreate_v4 .female_button {position:static!important;display:block;width:90px!important;height:44px!important;background:#eee2c5!important;border:1px solid #b4a27e;line-height:44px;text-align:center;}
#charcreate_v4 .male_button::after{content:'Male';}#charcreate_v4 .female_button::after{content:'Female';}
#charcreate_v4 input:checked + label {outline:2px solid #997634!important;outline-offset:-2px;}
#charcreate_v4 .model,#charcreate_v4 .model canvas {position:static!important;display:inline-block!important;}
#charcreate_v4 #style .rot_left,#charcreate_v4 #style .rot_right {position:static!important;vertical-align:bottom;}
#charcreate_v4 #char_name {position:static!important;display:block;width:100%!important;margin:8px 0;border:1px solid #b4a27e!important;background:white;border-radius:4px;padding:8px;}
#charcreate_v4 #hair_setting {max-width:100%;overflow:auto;}
#charcreate_v4 .hair_styles,#charcreate_v4 .hair_colors {position:relative!important;inset:auto!important;max-width:100%;}
#charcreate_v4 .hair_style_title,#charcreate_v4 .hair_color_title{position:static!important;width:100%!important;height:auto!important;margin:8px 0;font:16px system-ui;}
#charcreate_v4 .hair-style{position:relative!important;inset:auto!important;height:auto!important;}
#charcreate_v4 .hairstyle_row,#charcreate_v4 .haircolor_row{inset:auto!important;gap:4px;flex-wrap:wrap;}
#charcreate_v4 .styleCol,#charcreate_v4 .colorCol{width:44px!important;height:44px!important;min-width:44px;margin:0 0 4px!important;}
#charcreate_v4 .hstyle_button,#charcreate_v4 .hcolor_button{width:44px!important;height:44px!important;box-sizing:border-box;border:1px solid #b5a580;}
#charcreate_v4 .btns {position:sticky!important;bottom:-12px;height:auto!important;display:flex;gap:8px;background:#fff7e8;padding:8px 0;z-index:100;}
#charcreate_v4 .btns .btn {position:static!important;flex:1;}
`;
  if (name === "ChatBox")
    return `${buttonStyle}
:host{left:8px!important;top:auto!important;bottom:calc(var(--ro-keyboard-height,0px) + env(safe-area-inset-bottom) + 8px)!important;
 width:calc(var(--ro-view-width,100vw) - 16px)!important;max-height:44vh!important;z-index:3000!important;}
#chatbox {width:100%!important;max-width:100%!important;background:#171511ed;}
#chatbox .content {width:100%!important;box-sizing:border-box;max-height:25vh!important;}
#chatbox .input {display:block!important;width:100%!important;min-height:44px;}
#chatbox .input input {font:16px system-ui!important;min-height:44px;box-sizing:border-box;}
#chatbox .input .wrapper,#chatbox .input .message {width:100%!important;}
#chatbox .battlemode{display:none!important;}
`;
  if (name === "NpcBox")
    return `${safePanel}${buttonStyle}
:host {width:calc(var(--ro-view-width,100vw) - 16px)!important;height:auto!important;top:calc(var(--ro-view-top,0px) + 72px)!important;z-index:calc(4000 + var(--ro-native-z,50))!important;}
#NpcBox,#NpcBox .border {position:relative!important;width:auto!important;height:auto!important;box-sizing:border-box;}
#NpcBox .content {width:auto!important;height:auto!important;min-height:100px;max-height:30vh!important;font:16px/1.5 system-ui!important;overflow:auto;}
#NpcBox .btns {position:relative!important;inset:auto!important;display:flex;justify-content:flex-end;gap:8px;padding-top:8px;}
#NpcBox .btn {position:static!important;min-width:80px!important;}
`;
  if (name === "NpcMenu")
    return `${safePanel}${buttonStyle}
:host {width:calc(var(--ro-view-width,100vw) - 16px)!important;height:auto!important;top:calc(var(--ro-view-top,0px) + var(--ro-view-height,100dvh) * .48)!important;z-index:calc(4000 + var(--ro-native-z,50))!important;}
#NpcMenu,#NpcMenu .container {position:relative!important;width:auto!important;height:auto!important;box-sizing:border-box;}
#NpcMenu .middle {max-height:24vh;overflow:auto;}
#NpcMenu .title,#NpcMenu .content {width:auto!important;height:auto!important;font:16px/1.4 system-ui;}
#NpcMenu .content div {min-height:44px!important;height:auto!important;padding:10px;box-sizing:border-box;}
#NpcMenu .btn {position:static!important;min-width:88px!important;margin:6px 8px 4px 0;}
`;
  if (/^Inventory/.test(name))
    return `${safePanel}${buttonStyle}
:host {width:min(420px,calc(var(--ro-view-width,100vw) - 16px))!important;height:auto!important;z-index:calc(4000 + var(--ro-native-z,50))!important;}
#InventoryV3 {height:auto!important;min-height:260px;}
#InventoryV3 .titlebar{min-height:44px!important;height:auto!important;display:flex;align-items:center;justify-content:space-between;}
#InventoryV3 .titlebar .close{width:64px!important;min-height:44px!important;}
#InventoryV3 .titlebar .text{font:16px system-ui!important;width:auto!important;}
#InventoryV3 .middle{flex-direction:column;}
#InventoryV3 .tabs{flex-direction:row!important;width:100%!important;background:none!important;}
#InventoryV3 .tabs .tab{writing-mode:horizontal-tb!important;text-orientation:mixed!important;left:0!important;min-width:44px!important;min-height:44px!important;font:14px system-ui!important;transform:none!important;}
#InventoryV3 .container{padding:0!important;border:0!important;box-shadow:none!important;}
#InventoryV3 .content{width:100%!important;grid-template-columns:repeat(auto-fill,minmax(44px,1fr))!important;grid-auto-rows:44px!important;min-height:176px!important;max-height:42vh;overflow:auto!important;margin:0!important;background-image:none!important;background-color:#f4eee1!important;}
#InventoryV3 .titlebar .clear{display:none;}
#InventoryV3 .titlebar .base:not(.close),#InventoryV3 .extend{display:none!important;}
#InventoryV3 .titlebar .right{margin-left:auto;}
#InventoryV3 .content .item{width:44px!important;height:44px!important;border:1px solid #d0c4a6;box-sizing:border-box;}
#InventoryV3 .content .item .icon{left:9px!important;top:9px!important;}
`;
  if (
    /^(Equipment|Storage|SkillList|Quest|NpcStore|VendingShop|InputBox|WinPrompt|WinMSG|WinError|WinPopup|ItemInfo|ItemSelection|WinStats|PartyFriends)/.test(
      name,
    )
  )
    return `${safePanel}${buttonStyle}${/^Win(Prompt|MSG|Error|Popup)/.test(name) ? ":host{z-index:5100!important;}" : ""}
.ui-component-root {min-width:0;}
.titlebar {min-height:44px!important;height:auto!important;position:sticky!important;top:0;z-index:30;}
.titlebar .close,.titlebar .base,.titlebar .toggle {min-height:44px!important;min-width:44px!important;background-size:auto!important;}
.content {max-width:100%!important;overflow:auto!important;overscroll-behavior:contain;}
.tabs button,.item .btn,.btns button {min-height:44px!important;}
.container .item {min-width:44px!important;min-height:44px!important;}
`;
  return "";
}
