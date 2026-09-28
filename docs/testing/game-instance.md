# Game instance check

Manual end-to-end check of a game instance launched from the launch template: startup script,
Docker, the world data volume, instance metadata lockdown, and stop/terminate behaviour. First run
for M1; rerun after changes to the launch template, the startup script
(`infra/lib/user-data/game-instance.sh`) or the instance role.

The startup script's disk logic also has an automated test (`bash infra/test/user-data/run.sh`);
this check covers what that can't: real EBS/NVMe device names, systemd, SSM and Docker on an instance.

**Where to run:** AWS CloudShell in `us-west-2` (nothing to install) or any shell with the AWS CLI.
Shell steps on the instance use **EC2 → Instances → the instance → Connect → Session Manager**.
Costs a few cents; step 7 cleans everything up.

## 1. Launch an instance from the template

```bash
export AWS_REGION=us-west-2
ENV=dev
SUBNET=$(aws ec2 describe-subnets --filters Name=tag:app,Values=hearth Name=tag:env,Values=$ENV \
  --query 'Subnets[0].SubnetId' --output text)
ID=$(aws ec2 run-instances \
  --launch-template "LaunchTemplateName=hearth-$ENV-minecraft-java,Version=\$Latest" \
  --subnet-id $SUBNET \
  --query 'Instances[0].InstanceId' --output text)
echo $ID
aws ec2 wait instance-status-ok --instance-ids $ID   # ~2-3 min
```

Check the instance and its volumes came from the template:

```bash
aws ec2 describe-instances --instance-ids $ID \
  --query 'Reservations[0].Instances[0].[InstanceType,Architecture,PublicIpAddress,Tags]'
aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=$ID \
  --query 'Volumes[].[VolumeId,Size,Attachments[0].Device,Attachments[0].DeleteOnTermination,Tags[?Key==`env`].Value|[0]]' \
  --output table
```

| Expect | |
| --- | --- |
| Instance | `t4g.medium`, `arm64`, a public IP, tags `app`, `env`, `game`, `Name` |
| `/dev/xvda` | 16 GiB, `DeleteOnTermination` True |
| `/dev/sdf` | 10 GiB, `DeleteOnTermination` False, tagged with the environment |

## 2. Open a shell

Connect with Session Manager (see above). If it isn't offered yet, wait a minute for the SSM agent to
register. Getting a shell proves the instance role and SSM access work; there is no SSH.

## 3. Startup script, Docker and the data volume

```bash
cloud-init status                                            # status: done
sudo grep hearth-user-data /var/log/cloud-init-output.log    # "formatting empty data volume" ... "mounted at /srv/hearth"
ls -l /dev/sdf                                               # symlink to an nvme device
df -hT /srv/hearth                                           # xfs, ~10G
grep /srv/hearth /etc/fstab                                  # one UUID=... line with nofail
systemctl is-active docker                                   # active
sudo docker run --rm hello-world                             # runs an arm64 image
```

## 4. Containers can't reach instance credentials

```bash
sudo docker run --rm public.ecr.aws/amazonlinux/amazonlinux:2023 \
  curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || echo "blocked (expected)"
```

Expect `blocked (expected)`: the metadata hop limit of 1 stops containers from reaching it. The
same `curl` run directly on the host returns a token.

## 5. Data survives a reboot

```bash
echo "hello from the game instance check" | sudo tee /srv/hearth/test.txt
sudo reboot
```

Reconnect after about a minute:

```bash
cat /srv/hearth/test.txt                                     # the line written above
df -hT /srv/hearth                                           # remounted from fstab
sudo grep -c "formatting" /var/log/cloud-init-output.log     # still 1: the script didn't rerun
```

## 6. Shutting down stops the instance and data survives stop/start

On the instance:

```bash
sudo shutdown -h now
```

From CloudShell:

```bash
aws ec2 wait instance-stopped --instance-ids $ID && echo "stopped, not terminated"
aws ec2 start-instances --instance-ids $ID
aws ec2 wait instance-status-ok --instance-ids $ID
aws ec2 describe-instances --instance-ids $ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress'     # a new IP
```

Reconnect and `cat /srv/hearth/test.txt`: the file is still there.

## 7. Clean up; the data volume outlives the instance

```bash
VOL=$(aws ec2 describe-volumes \
  --filters Name=attachment.instance-id,Values=$ID Name=attachment.device,Values=/dev/sdf \
  --query 'Volumes[0].VolumeId' --output text)
aws ec2 terminate-instances --instance-ids $ID
aws ec2 wait instance-terminated --instance-ids $ID
aws ec2 describe-volumes --volume-ids $VOL --query 'Volumes[0].State'   # "available": it survived
aws ec2 delete-volume --volume-id $VOL
```

If the CloudShell session timed out, `$ID` and `$VOL` are gone: find leftovers with
`aws ec2 describe-instances --filters Name=tag:env,Values=$ENV Name=instance-state-name,Values=running,stopped`
and `aws ec2 describe-volumes --filters Name=tag:env,Values=$ENV Name=status,Values=available`.

## Troubleshooting

- **Startup script:** full log in `/var/log/cloud-init-output.log`; our lines start with `hearth-user-data:`.
- **"data volume /dev/sdf not found":** check `lsblk` and `ls -l /dev/sd*`; the device-name symlink
  from `amazon-ec2-utils` is missing.
- **No Session Manager option:** `aws ssm describe-instance-information`. The instance reaches SSM
  over its public IP (there's no NAT), so check it has one.
