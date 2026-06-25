import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DataSet, Edge, Network, Node, Options } from 'vis-network/standalone';
import { GraphApiService } from './graph-api.service';
import { GraphEdge, GraphNode, GraphQuery, GraphResponse, HealthResponse, MemoryUser } from './graph.models';

type HealthEntry = {
  name: string;
  ok: boolean;
  configured: boolean;
  error?: string;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('graphCanvas') graphCanvas?: ElementRef<HTMLDivElement>;

  users: MemoryUser[] = [];
  selectedUserKey = '';
  graph?: GraphResponse;
  warnings: string[] = [];
  relationTypes: string[] = [];
  availableStatuses = ['Active', 'Superseded', 'Forgotten'];
  healthEntries: HealthEntry[] = [];
  loading = false;
  networkReady = false;
  physicsEnabled = true;
  selectedNode?: GraphNode;
  selectedEdge?: GraphEdge;

  query: GraphQuery = {
    tenantId: 'default',
    userId: '',
    status: 'Active',
    relationType: '',
    search: '',
    limit: 150
  };

  private network?: Network;
  private readonly nodesData = new DataSet<Node>([]);
  private readonly edgesData = new DataSet<Edge>([]);

  constructor(private readonly api: GraphApiService) {}

  ngOnInit(): void {
    this.loadHealth();
    this.loadUsers();
  }

  ngAfterViewInit(): void {
    this.createNetwork();
    this.loadGraph();
  }

  ngOnDestroy(): void {
    this.network?.destroy();
  }

  loadHealth(): void {
    this.api.health().subscribe({
      next: response => {
        this.healthEntries = this.mapHealth(response);
      },
      error: error => {
        this.healthEntries = [{ name: 'api', ok: false, configured: true, error: error.message }];
      }
    });
  }

  loadUsers(): void {
    this.api.users().subscribe({
      next: response => {
        this.users = response.users;
        this.warnings = response.warnings ?? [];
        if (!this.query.userId && this.users.length > 0) {
          const first = this.users[0];
          this.query.tenantId = first.tenantId;
          this.query.userId = first.userId;
          this.selectedUserKey = this.userKey(first.tenantId, first.userId);
        }
      },
      error: error => {
        this.warnings = [`No se pudieron cargar usuarios: ${error.message}`];
      }
    });
  }

  loadGraph(): void {
    this.loading = true;
    this.selectedNode = undefined;
    this.selectedEdge = undefined;

    this.api.graph(this.query).subscribe({
      next: response => {
        this.graph = response;
        this.warnings = response.warnings ?? [];
        this.relationTypes = response.filters?.relationTypes ?? [];
        this.availableStatuses = response.filters?.statuses?.length ? response.filters.statuses : this.availableStatuses;
        this.renderGraph(response);
        this.loading = false;
      },
      error: error => {
        this.warnings = [`No se pudo cargar el grafo: ${error.message}`];
        this.loading = false;
      }
    });
  }

  applySelectedUser(): void {
    if (!this.selectedUserKey) {
      this.query.tenantId = '';
      this.query.userId = '';
      return;
    }

    const [tenantId, userId] = this.selectedUserKey.split('::');
    this.query.tenantId = tenantId;
    this.query.userId = userId;
    this.loadGraph();
  }

  userKey(tenantId: string, userId: string): string {
    return `${tenantId}::${userId}`;
  }

  fitGraph(): void {
    this.network?.fit({ animation: { duration: 350, easingFunction: 'easeInOutQuad' } });
  }

  stabilizeGraph(): void {
    this.network?.stabilize(120);
  }

  togglePhysics(): void {
    this.physicsEnabled = !this.physicsEnabled;
    this.network?.setOptions({ physics: { enabled: this.physicsEnabled } });
  }

  private createNetwork(): void {
    if (!this.graphCanvas) {
      return;
    }

    const options: Options = {
      autoResize: true,
      interaction: {
        hover: true,
        multiselect: false,
        navigationButtons: true,
        keyboard: true
      },
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -60,
          centralGravity: 0.012,
          springLength: 130,
          springConstant: 0.08
        },
        stabilization: {
          enabled: true,
          iterations: 180,
          fit: true
        }
      },
      nodes: {
        borderWidth: 1,
        borderWidthSelected: 2,
        font: {
          color: '#16202a',
          size: 14,
          face: 'Inter, system-ui, sans-serif'
        },
        shadow: {
          enabled: true,
          color: 'rgba(20, 39, 57, 0.18)',
          size: 8,
          x: 0,
          y: 3
        }
      },
      edges: {
        arrows: {
          to: { enabled: true, scaleFactor: 0.7 }
        },
        color: {
          color: '#8191a4',
          highlight: '#235789',
          hover: '#235789'
        },
        font: {
          color: '#425466',
          size: 11,
          align: 'middle',
          strokeWidth: 3,
          strokeColor: '#f7f9fb'
        },
        smooth: {
          enabled: true,
          type: 'dynamic',
          roundness: 0.35
        }
      }
    };

    this.network = new Network(
      this.graphCanvas.nativeElement,
      { nodes: this.nodesData, edges: this.edgesData },
      options
    );

    this.network.on('selectNode', params => {
      const id = String(params.nodes[0]);
      this.selectedNode = this.graph?.nodes.find(node => node.id === id);
      this.selectedEdge = undefined;
    });

    this.network.on('selectEdge', params => {
      const id = String(params.edges[0]);
      this.selectedEdge = this.graph?.edges.find(edge => edge.id === id);
      this.selectedNode = undefined;
    });

    this.network.on('deselectNode', () => {
      this.selectedNode = undefined;
    });

    this.network.on('deselectEdge', () => {
      this.selectedEdge = undefined;
    });

    this.networkReady = true;
  }

  private renderGraph(response: GraphResponse): void {
    const nodes = response.nodes.map(node => ({
      id: node.id,
      label: node.label,
      title: `${node.type} / ${node.status}`,
      value: Math.max(8, node.degree + 8),
      shape: this.nodeShape(node.type),
      color: this.nodeColor(node.type, node.status)
    }));

    const edges = response.edges.map(edge => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.relationType,
      title: `${edge.relationType} (${edge.confidence.toFixed(2)})`,
      width: Math.max(1, edge.confidence * 4)
    }));

    this.nodesData.clear();
    this.edgesData.clear();
    this.nodesData.add(nodes);
    this.edgesData.add(edges);

    window.setTimeout(() => this.fitGraph(), 80);
  }

  private mapHealth(response: HealthResponse): HealthEntry[] {
    return Object.entries(response.checks).map(([name, check]) => ({
      name,
      ok: check.ok,
      configured: check.configured,
      error: check.error
    }));
  }

  private nodeShape(type: string): Node['shape'] {
    const normalized = type.toLowerCase();
    if (normalized.includes('person')) return 'dot';
    if (normalized.includes('project')) return 'database';
    if (normalized.includes('database')) return 'box';
    if (normalized.includes('concept')) return 'ellipse';
    return 'dot';
  }

  private nodeColor(type: string, status: string): Node['color'] {
    if (status !== 'Active') {
      return { background: '#d7dde5', border: '#8d99a8', highlight: { background: '#c7d0da', border: '#617086' } };
    }

    const normalized = type.toLowerCase();
    if (normalized.includes('person')) {
      return { background: '#c9e7dd', border: '#2f7f63', highlight: { background: '#b4dece', border: '#1f6f54' } };
    }

    if (normalized.includes('project')) {
      return { background: '#cfe1f6', border: '#2d6da3', highlight: { background: '#bad4f1', border: '#235789' } };
    }

    if (normalized.includes('database')) {
      return { background: '#f4d6c5', border: '#b35d32', highlight: { background: '#efc7ae', border: '#9d4a25' } };
    }

    if (normalized.includes('technology')) {
      return { background: '#f2e3a8', border: '#9b7f17', highlight: { background: '#ead687', border: '#816910' } };
    }

    return { background: '#d8e1e8', border: '#607487', highlight: { background: '#c8d5df', border: '#465d73' } };
  }
}
