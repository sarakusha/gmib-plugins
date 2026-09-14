import { $, esc, api, notify, realtime } from './common.js';
let sports=[], teams=[], members=[], selected, emblem='', people=[];
const field=(form,name)=>form.elements.namedItem(name);
const protect=work=>async event=>{if(event?.type==='submit')event.preventDefault();try{await work(event);}catch(error){notify(error.message,true); const open=document.querySelector('dialog[open]');if(open)open.close();}};
async function loadTeams(){
 const sport=sports.find(item=>item.id===$('#sport').value);
 teams=sport?await api(`teams?sportId=${encodeURIComponent(sport.id)}`):[];
 $('#sport-status').textContent=sport?.ready?'Доступен':sport?'Плагин спорта недоступен. Составы сохранены.':'Установите спортивный плагин, например «Хоккей · Light».';
 $('#new-team').disabled=!sport?.ready;
 selected=teams.find(team=>team.id===selected?.id)??teams[0];
 $('#teams').innerHTML=teams.map(team=>`<button data-team="${esc(team.id)}" class="${team.id===selected?.id?'active':''}">${esc(team.name)}<small>${esc(team.city)}</small></button>`).join('');
 await loadMembers();
}
async function loadMembers(){
 $('#empty').hidden=Boolean(selected);$('#team-area').hidden=!selected;if(!selected)return;
 $('#team-title').textContent=selected.name;
 const sport=sports.find(item=>item.id===selected.sportId);
 $('#edit-team').disabled=$('#add-member').disabled=!sport?.ready;
 members=await api(`members?teamId=${encodeURIComponent(selected.id)}`);
 $('#members').innerHTML=members.map(member=>`<tr><td class="number">${esc(member.number||'—')}</td><td>${esc(member.lastName)} ${esc(member.firstName)} ${member.captain?'<span class="badge">К</span>':''}${!member.active?' <small>вне заявки</small>':''}</td><td>${esc(sport?.positions.find(position=>position.id===member.position)?.name||member.position)}</td><td><button class="ghost" data-member="${esc(member.participantId)}" ${sport?.ready?'':'disabled'}>Изменить</button></td></tr>`).join('');
 $('#member-empty').hidden=members.length>0;
}
async function refresh(){const previous=$('#sport').value;sports=await api('sports');$('#sport').innerHTML=sports.map(sport=>`<option value="${esc(sport.id)}">${esc(sport.name)}</option>`).join('');if(sports.some(sport=>sport.id===previous))$('#sport').value=previous;await loadTeams();}
function editTeam(team){const form=$('#team-form');form.reset();for(const name of ['id','name','shortName','city','color'])field(form,name).value=team?.[name]??(name==='color'?'#40d9ac':'');emblem=team?.logo||'';$('#logo-preview').src=emblem;$('#logo-preview').hidden=!emblem;$('#archive').hidden=!team;$('#team-dialog').showModal();}
async function editMember(member){const form=$('#member-form');form.reset();$('#position').innerHTML='<option value="">Не указана</option>'+sports.find(sport=>sport.id===selected.sportId).positions.map(position=>`<option value="${esc(position.id)}">${esc(position.name)}</option>`).join('');for(const name of ['participantId','lastName','firstName','number','position'])field(form,name).value=member?.[name]??'';field(form,'captain').checked=Boolean(member?.captain);field(form,'active').checked=member?Boolean(member.active):true;people=await api('participants');$('#existing').innerHTML='<option value="">Новый участник</option>'+people.filter(person=>!members.some(item=>item.participantId===person.id)).map(person=>`<option value="${esc(person.id)}">${esc(person.lastName)} ${esc(person.firstName)}</option>`).join('');$('#existing-label').hidden=Boolean(member);$('#member-dialog').showModal();}
$('#sport').onchange=protect(loadTeams);
$('#teams').onclick=protect(async event=>{const id=event.target.closest('[data-team]')?.dataset.team;if(id){selected=teams.find(team=>team.id===id);await loadTeams();}});
$('#members').onclick=protect(async event=>{const id=event.target.closest('[data-member]')?.dataset.member;if(id)await editMember(members.find(member=>member.participantId===id));});
$('#new-team').onclick=()=>editTeam();$('#edit-team').onclick=()=>editTeam(selected);$('#add-member').onclick=protect(()=>editMember());
$('#existing').onchange=()=>{const person=people.find(item=>item.id===$('#existing').value);for(const name of ['firstName','lastName'])field($('#member-form'),name).value=person?.[name]??'';field($('#member-form'),'participantId').value=person?.id??'';};
$('#team-form').onsubmit=protect(async()=>{const b=Object.fromEntries(new FormData($('#team-form')));selected=await api('teams',{...b,sportId:$('#sport').value,logo:emblem},'PUT');$('#team-dialog').close();await loadTeams();notify('Команда сохранена');});
$('#member-form').onsubmit=protect(async()=>{const form=$('#member-form');await api('members',{...Object.fromEntries(new FormData(form)),teamId:selected.id,captain:field(form,'captain').checked,active:field(form,'active').checked},'PUT');$('#member-dialog').close();await loadMembers();notify('Участник сохранён');});
$('#archive').onclick=protect(async()=>{if(!confirm('Архивировать команду? Сохранённые матчи останутся без изменений.'))return;await api('teams',{...selected,archived:true},'PUT');$('#team-dialog').close();selected=undefined;await loadTeams();});
$('#logo-file').onchange=protect(async()=>{const file=$('#logo-file').files[0];if(!file)return;if(file.size>250000)throw new Error('Эмблема должна быть меньше 250 КБ');emblem=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});$('#logo-preview').src=emblem;$('#logo-preview').hidden=false;});
$('#clear-logo').onclick=()=>{emblem='';$('#logo-preview').hidden=true;};
$('#backup').onclick=protect(async()=>{const data=await api('backup');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download=`gmib-rosters-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
$('#restore').onclick=()=>$('#backup-file').click();$('#backup-file').onchange=protect(async()=>{const file=$('#backup-file').files[0];if(!file)return;if(file.size>20000000)throw new Error('Слишком большой файл');if(!confirm('Заменить справочник данными резервной копии? Сначала сохраните текущую копию.'))return;await api('restore',JSON.parse(await file.text()));await refresh();notify('Справочник восстановлен');});
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
realtime(message=>{if(message.event==='plugin:sports-roster:changed'&&!document.querySelector('dialog[open]'))void refresh().catch(error=>notify(error.message,true));},connected=>{if(connected)void refresh().catch(error=>notify(error.message,true));else notify('Нет связи с gmib. Изменения временно недоступны.',true);});
await refresh().catch(error=>notify(error.message,true));
