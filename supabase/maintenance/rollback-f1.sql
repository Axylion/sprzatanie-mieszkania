-- Run only to roll F1 back in goleszan-19-test. Retains all recorded data.
begin;
revoke execute on function public.g19_web_admin_save_duty(integer, date, boolean),
  public.g19_web_admin_send_duty(integer, date, uuid) from authenticated;

update g19_private.manual_duty_recipients
  set outcome = 'failed' where outcome is null;
update g19_private.push_delivery q set finished = true, lease = null
  from g19_private.manual_duty_recipients m
  where q.notification_id = m.notification_id and not q.finished;
update g19_private.notification_inbox n set presented_at = coalesce(n.presented_at, statement_timestamp())
  from g19_private.manual_duty_recipients m
  where n.id = m.notification_id;
commit;
