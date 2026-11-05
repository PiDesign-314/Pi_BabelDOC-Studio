/* Application shortcuts replace navigation menus outside editable controls. */
(() => {
  if (document.body.classList.contains('reader')) return;
  const menu = document.createElement('div');
  menu.hidden = true;
  Object.assign(menu.style,{position:'fixed',zIndex:9999,padding:'6px',borderRadius:'14px',background:'var(--bg-elevated)',boxShadow:'0 8px 40px #0003',minWidth:'160px'});
  menu.setAttribute('role','menu');
  for (const [name,action] of [['翻译工作台',()=>location.href='/'],['结果库',()=>location.href='/library'],['切换外观',()=>document.querySelector('#btn-theme')?.click()]]) {
    const button=document.createElement('button');button.textContent=name;button.type='button';
    Object.assign(button.style,{display:'block',width:'100%',padding:'10px',textAlign:'left',color:'var(--text)',background:'transparent',border:0,borderRadius:'8px',cursor:'pointer'});
    button.onclick=()=>{menu.hidden=true;action();};menu.append(button);
  }
  document.body.append(menu);
  document.addEventListener('contextmenu',e=>{
    if(e.target.closest('input,textarea,[contenteditable=true]'))return;
    e.preventDefault();menu.hidden=false;
    menu.style.left=`${Math.max(8,Math.min(e.clientX,innerWidth-menu.offsetWidth-8))}px`;
    menu.style.top=`${Math.max(8,Math.min(e.clientY,innerHeight-menu.offsetHeight-8))}px`;
  });
  document.addEventListener('pointerdown',e=>{if(!menu.contains(e.target))menu.hidden=true;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')menu.hidden=true;});
})();
