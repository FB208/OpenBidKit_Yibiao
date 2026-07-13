import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import type { RequiredOnlineServiceStatus } from '../shared/types/ipc';

// 软件启动后提示本次运行期间不可用的必须联网服务。
function RequiredOnlineServicesPrompt() {
  const [unavailableServices, setUnavailableServices] = useState<RequiredOnlineServiceStatus[]>([]);

  useEffect(() => {
    let disposed = false;

    void window.yibiao?.requiredOnlineServices.getStatus()
      .then((status) => {
        if (!disposed) {
          setUnavailableServices(status?.unavailableServices || []);
        }
      })
      .catch((error) => console.warn('读取必须联网服务状态失败', error));

    return () => {
      disposed = true;
    };
  }, []);

  return (
    <Dialog.Root
      open={unavailableServices.length > 0}
      onOpenChange={(open) => {
        if (!open) setUnavailableServices([]);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="content-regenerate-card required-online-services-card">
          <div className="content-regenerate-card-head">
            <Dialog.Title>联网服务不可用</Dialog.Title>
            <Dialog.Description>
              以下服务当前无法连接，相关功能在本次软件运行期间将自动跳过，不会等待超时。
            </Dialog.Description>
          </div>
          <ul className="required-online-services-list">
            {unavailableServices.map((service) => (
              <li key={service.id}>
                <strong>{service.label}</strong>
                <span>{service.domain}</span>
              </li>
            ))}
          </ul>
          <div className="content-regenerate-actions">
            <button type="button" className="primary-action" onClick={() => setUnavailableServices([])}>我知道了</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default RequiredOnlineServicesPrompt;
