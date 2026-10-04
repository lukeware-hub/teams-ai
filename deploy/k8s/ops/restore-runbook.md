# Restore runbook (data PVC)

The CronJob `teams-ai-backup` writes `teams-ai-<UTC stamp>.tar.gz` to PVC `teams-ai-backup` (newest 7 kept).
The archive holds the whole data volume (config, secrets, runs, workspaces).

Placeholders: `NS` is the namespace, `teams-ai` the Deployment, `teams-ai-data` the data PVC.

1. Pick the archive. Run a throwaway pod that mounts the backup PVC and list it:
   `kubectl -n NS run lsbackup --rm -it --restart=Never --image=busybox:1.36 --overrides='{"spec":{"containers":[{"name":"lsbackup","image":"busybox:1.36","command":["ls","-lt","/backup"],"volumeMounts":[{"name":"b","mountPath":"/backup"}]}],"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"teams-ai-backup"}}]}}'`
2. Stop writers: `kubectl -n NS scale deploy/teams-ai --replicas=0` and wait for the pod to terminate. Active
   runs are interrupted; they are resumed after the restore (see the operator runbook).
3. Restore with a Job (replace the stamp):
   ```yaml
   apiVersion: batch/v1
   kind: Job
   metadata: { name: teams-ai-restore }
   spec:
     backoffLimit: 0
     template:
       spec:
         restartPolicy: Never
         containers:
           - name: restore
             image: busybox:1.36
             command: [sh, -ec, "find /data -mindepth 1 -delete && tar -xzf /backup/teams-ai-STAMP.tar.gz -C /data"]
             volumeMounts:
               - { name: data, mountPath: /data }
               - { name: backup, mountPath: /backup, readOnly: true }
         volumes:
           - { name: data, persistentVolumeClaim: { claimName: teams-ai-data } }
           - { name: backup, persistentVolumeClaim: { claimName: teams-ai-backup } }
   ```
   `kubectl -n NS apply -f restore.yaml && kubectl -n NS wait --for=condition=complete job/teams-ai-restore --timeout=600s`
4. Delete the Job: `kubectl -n NS delete job teams-ai-restore`.
5. Start: `kubectl -n NS scale deploy/teams-ai --replicas=1`; wait for readiness (`/healthz`).
6. Remove stale locks and resume interrupted runs as described in `docs/superpowers/ops/runbook.md`.

To test the procedure without touching production, restore into a scratch PVC and inspect it with a pod.
Take a manual backup first with `kubectl -n NS create job --from=cronjob/teams-ai-backup manual-$(date +%s)`.
